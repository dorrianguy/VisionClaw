import { classifyIntent, AgentType, isVisionAgent } from './classifier';
import { requiresConfirmation, classifyTask, createConfirmation } from '../safety/gate';
import { indexMemory } from '../memory/store';
import {
  startSession as startInventory,
  endSession as endInventory,
  getActiveSession as getActiveInventory,
  addItem, setCurrentAisle,
  recordImageCapture, addNote, getProgressStats,
} from '../inventory/session';
import { lookupUpc } from '../inventory/product-db';
import { exportToCsv, generateTtsSummary } from '../inventory/export';
import { createLogger } from '../logger';

const logger = createLogger('executor');

export interface ExecuteResult {
  success: boolean;
  result: string;
  agent: AgentType;
  intent: string;
  confirmationRequired?: boolean;
  confirmationId?: string;
  confirmationSummary?: string;
  /** Signals to the client that the agent expects an image capture */
  requiresImage?: boolean;
}

// ─── Active session state for stateful agents (meeting, inspection, chain) ───

interface ActiveSession {
  agent: AgentType;
  startedAt: number;
  metadata: Record<string, unknown>;
}

const activeSessions = new Map<AgentType, ActiveSession>();

export async function executeTask(task: string): Promise<ExecuteResult> {
  // Step 1: Classify intent and route to sub-agent
  const classification = classifyIntent(task);
  logger.info({ agent: classification.agent, intent: classification.intent }, 'Routing task');

  // Step 2: Check safety gates
  if (requiresConfirmation(task)) {
    const category = classifyTask(task);
    const confirmation = createConfirmation(task, category);

    return {
      success: true,
      result: confirmation.summary,
      agent: classification.agent,
      intent: classification.intent,
      confirmationRequired: true,
      confirmationId: confirmation.id,
      confirmationSummary: confirmation.summary,
    };
  }

  // Step 3: Execute via the appropriate agent
  const result = await routeToAgent(classification.agent, task, classification.intent);

  return {
    success: true,
    result,
    agent: classification.agent,
    intent: classification.intent,
    requiresImage: classification.requiresImage,
  };
}

async function routeToAgent(agent: AgentType, task: string, intent: string): Promise<string> {
  // Auto-index every vision agent execution into the memory store.
  // This ensures all visual captures are searchable regardless of which agent handles them.
  if (isVisionAgent(agent)) {
    try {
      indexMemory({
        timestamp: Date.now(),
        latitude: null,
        longitude: null,
        location: null,
        sceneType: null,
        summary: `[${agent}] ${task}`,
        extractedText: null,
        detectedObjects: [],
        tags: [agent, intent],
        sourceAgent: agent,
        imagePath: null, // Image saved separately when client sends frame data
        embedding: null, // Embedding generated async after vision model processes frame
      });
    } catch (err) {
      // Memory indexing should never block task execution
      logger.warn({ err, agent }, 'Failed to auto-index memory (non-blocking)');
    }
  }

  switch (agent) {
    // ─── Vision Feature Agents ───
    case 'memory':       return handleMemory(task, intent);
    case 'networking':   return handleNetworking(task, intent);
    case 'deal':         return handleDeal(task, intent);
    case 'security':     return handleSecurity(task, intent);
    case 'meeting':      return handleMeeting(task, intent);
    case 'debug':        return handleDebug(task, intent);
    case 'inspection':   return handleInspection(task, intent);
    case 'context':      return handleContext(task, intent);
    case 'translation':  return handleTranslation(task, intent);
    case 'chain':        return handleChain(task, intent);
    // ─── Core Agents ───
    case 'comms':        return handleComms(task, intent);
    case 'research':     return handleResearch(task, intent);
    case 'ops':          return handleOps(task, intent);
    case 'smart_home':   return handleSmartHome(task, intent);
    case 'siberius':
    default:             return handleGeneral(task, intent);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  VISION FEATURE AGENTS
//  Each handler follows the pipeline from VISION-FEATURES-SPEC.md
//  TODO markers show where to plug in real integrations
// ═══════════════════════════════════════════════════════════════════

/**
 * Feature 1: Perfect Memory / Life Indexing
 * Foundation layer — all other vision agents feed into this.
 *
 * Pipeline: camera_snap → vision model analysis → extract text/objects/scene →
 *           structured metadata → store in SQLite + vector embeddings →
 *           natural language query interface
 *
 * Storage: Local SQLite + embeddings (offline-capable)
 * Retention: Configurable 7d/30d/90d/forever
 */
async function handleMemory(task: string, intent: string): Promise<string> {
  logger.info({ intent }, 'Memory agent handling');

  switch (intent) {
    case 'store_memory': {
      // TODO: Pipeline implementation
      // 1. Receive image from camera_snap (passed via request context)
      // 2. Send to vision model (GPT-4o / Claude) for analysis:
      //    - OCR text extraction (whiteboards, signs, screens, documents)
      //    - Object detection + classification
      //    - Scene description + type (indoor/outdoor, room type)
      //    - People detection (count, not identification unless enrolled)
      //    - Location inference from visual cues
      // 3. Generate structured metadata:
      //    { timestamp, gps_location?, scene_type, extracted_text[],
      //      detected_objects[], detected_people_count, summary, tags[] }
      // 4. Generate embedding from summary + extracted_text for vector search
      // 5. Store in SQLite: full metadata + image path + embedding
      // 6. Auto-filter low-value snaps (blank walls, pockets, blur)
      return 'Memory stored. Image captured and indexed with text, objects, and scene metadata. Searchable by natural language query.';
    }

    case 'query_memory': {
      // TODO: Pipeline implementation
      // 1. Parse natural language query → extract search terms + time range
      //    e.g., "what was on the whiteboard Tuesday" → { text: "whiteboard", timeRange: "last Tuesday" }
      // 2. Generate query embedding
      // 3. Vector similarity search in SQLite + keyword fallback
      // 4. Rank results by relevance + recency
      // 5. Return top matches with extracted text + photo reference
      // 6. TTS response: "I found 3 whiteboard captures from Tuesday. The standup board showed: [text]"
      return 'Searching visual memory... Query received. Will return matching captures with extracted text and timestamps.';
    }

    case 'delete_memory': {
      // TODO: Parse time range ("last hour", "last 30 minutes", "today")
      // Delete matching entries from SQLite + remove image files
      // Confirm deletion count via TTS
      return 'Memory deletion request received. Specify time range to purge (e.g., "last hour", "today").';
    }

    case 'browse_memory': {
      // TODO: Return summary of recent captures
      // "You have 47 captures today: 12 from the office, 8 from the coffee shop, 27 from the store"
      return 'Browsing visual memory. Showing recent capture summary.';
    }

    default:
      return `Memory agent received task: "${task}". Processing.`;
  }
}

/**
 * Feature 2: Networking Superpower
 *
 * Pipeline: camera_snap (badge/card/person) → vision model extracts name/title/company →
 *           web research agent (LinkedIn, Crunchbase, Google News, Twitter) →
 *           synthesize 15-30 second briefing → TTS delivery
 *
 * Speed target: <10-15 seconds from snap to briefing
 * Data sources: LinkedIn, Crunchbase/PitchBook, Google News, Twitter/X, company website
 */
async function handleNetworking(task: string, intent: string): Promise<string> {
  logger.info({ intent }, 'Networking agent handling');

  switch (intent) {
    case 'identify_person': {
      // TODO: Pipeline implementation
      // 1. Receive image from camera_snap
      // 2. Vision model extracts: name, title, company, email, phone, social handles
      //    - Name badge detection + OCR
      //    - Business card detection + structured extraction
      //    - Face matching against enrolled contacts (if enabled)
      // 3. Spawn parallel web research:
      //    - LinkedIn profile lookup (name + company)
      //    - Company news (last 30 days) from Google News
      //    - Funding/financial events from Crunchbase
      //    - Mutual connections (if LinkedIn integrated)
      //    - Recent social posts/articles
      //    - Company tech stack (for tech events)
      // 4. Synthesize into TTS briefing (15-30 seconds max):
      //    "[Name], [title] at [company]. [1-2 relevant facts]. [Suggested conversation opener]."
      // 5. Cache result for repeat encounters
      // 6. Auto-save to contacts database
      return 'Identifying person... Extracting name and title from image. Researching professional profile. Briefing incoming.';
    }

    case 'pre_meeting_brief': {
      // TODO: Pipeline implementation
      // 1. Pull attendee list from calendar event (next upcoming or specified)
      // 2. For each attendee, run identify_person pipeline (without image)
      // 3. Synthesize combined briefing: key people, talking points, company context
      // 4. Deliver via TTS on the way to the meeting
      return 'Pre-meeting briefing mode. Pulling attendee list from calendar and researching each person.';
    }

    case 'save_contact': {
      // TODO: Extract contact info from image or last identification
      // Create/update contact entry with all gathered intel
      // Confirm via TTS: "Saved [Name] from [Company] to your contacts"
      return 'Saving contact information from captured card or badge.';
    }

    case 'research_person': {
      // TODO: Name-only research (no image required)
      // Parse name from task → run web research pipeline
      return 'Researching person. Running LinkedIn, news, and social media lookup.';
    }

    default:
      return `Networking agent received task: "${task}". Processing.`;
  }
}

/**
 * Feature 3: Live Deal / Price Intelligence
 *
 * Pipeline: camera_snap → identify product/vehicle/property →
 *           specialized research agent (per category) →
 *           price verdict + negotiation leverage → TTS delivery
 *
 * Categories: Vehicle, Product (retail), Real Estate
 * Output: "Verdict: [overpriced/fair/good deal]. [Key data points]. [Negotiation leverage]."
 */
async function handleDeal(task: string, intent: string): Promise<string> {
  logger.info({ intent }, 'Deal intelligence agent handling');

  switch (intent) {
    case 'product_price': {
      // TODO: Pipeline implementation
      // 1. camera_snap → vision model identifies product
      // 2. Barcode/UPC detection + decode
      // 3. Parallel price lookup:
      //    - Amazon price + history (CamelCamelCamel API or scrape)
      //    - eBay sold listings
      //    - Wholesale sources (Alibaba, DHgate)
      //    - Review summary (aggregate rating)
      // 4. Compare to current visible price (from shelf label OCR)
      // 5. TTS: "This is $45 here. Amazon has it for $32. Average review: 4.2 stars.
      //          Wholesale: $8/unit. Verdict: overpriced by $13."
      return 'Price check initiated. Identifying product and looking up pricing across Amazon, eBay, and wholesale sources.';
    }

    case 'vehicle_analysis': {
      // TODO: Pipeline implementation
      // 1. camera_snap → extract VIN, year/make/model, mileage, trim from sticker/window
      // 2. VIN decode via NHTSA API (free)
      // 3. Parallel lookup:
      //    - KBB / Edmunds fair market value
      //    - CarGurus / AutoTrader comparable listings in area
      //    - NHTSA recall database
      //    - Dealer invoice price (if available)
      //    - Depreciation curve position
      // 4. TTS: "This 2024 RAV4 XLE has a dealer cost of $29,800. Average selling price
      //          in your area: $31,400. This sticker at $34,500 is $3,100 over market.
      //          Known issue: transmission recall on early 2024 builds."
      return 'Vehicle analysis initiated. Reading sticker/VIN and pulling market data, recalls, and comparable listings.';
    }

    case 'real_estate_comp': {
      // TODO: Pipeline implementation
      // 1. camera_snap → extract address, listing price, sq ft, beds/baths from sign/listing
      // 2. Parallel lookup:
      //    - Recent comps (Zillow, Redfin APIs)
      //    - Tax assessment history
      //    - Zoning info
      //    - Flood zone / natural hazard data
      //    - School ratings + crime stats
      //    - Estimated rent (for investment analysis)
      //    - Estimated rehab costs (if distressed)
      // 3. TTS: "Listed at $350K. Comps show $325-340K. Tax assessed at $310K.
      //          Good school district. No flood zone. As a rental: $1,800/mo estimated."
      return 'Real estate analysis initiated. Pulling comps, tax history, and neighborhood data.';
    }

    case 'deal_verdict': {
      // TODO: Generic deal analysis — auto-detect category from image content
      return 'Analyzing deal. Identifying product category and running appropriate price comparison.';
    }

    default:
      return `Deal intelligence agent received task: "${task}". Processing.`;
  }
}

/**
 * Feature 4: Situational Awareness / Security
 *
 * Pipeline: camera_snap → threat classification (physical/digital/document/social) →
 *           risk assessment (LOW/MEDIUM/HIGH/CRITICAL) → alert delivery via TTS
 *
 * Alert levels:
 *   CRITICAL: Immediate TTS alert
 *   HIGH: TTS within 5 seconds
 *   MEDIUM: Logged, available on voice query
 *   LOW: Logged silently
 */
async function handleSecurity(task: string, intent: string): Promise<string> {
  logger.info({ intent }, 'Security agent handling');

  switch (intent) {
    case 'qr_scan': {
      // TODO: Pipeline implementation
      // 1. camera_snap → detect and decode QR code (local decode, no API needed)
      // 2. If URL: analyze redirect chains, check domain age, verify SSL
      // 3. Check against: Google Safe Browsing API, VirusTotal, known phishing DBs
      // 4. Risk assessment: domain reputation + redirect analysis + SSL validity
      // 5. TTS: "This QR code links to [domain]. Domain registered 3 days ago.
      //          CAUTION: Redirects through 2 intermediate domains. Likely phishing."
      //    OR: "This QR code links to [domain]. Legitimate site. Safe to visit."
      return 'Scanning QR code. Decoding and analyzing URL safety — checking domain reputation, redirects, and known threat databases.';
    }

    case 'threat_assess': {
      // TODO: Pipeline implementation
      // 1. camera_snap → vision model threat classification:
      //    Physical: ATM/payment terminal anomalies, suspicious devices, skimmers
      //    Digital: Wi-Fi SSID spoofing, screen visibility to others
      //    Social: Fake badges, unusual behavior patterns
      // 2. Risk level assignment: LOW/MEDIUM/HIGH/CRITICAL
      // 3. Alert via TTS based on severity
      return 'Running threat assessment on captured image. Checking for physical, digital, and social engineering threats.';
    }

    case 'contract_review': {
      // TODO: Pipeline implementation
      // 1. camera_snap → high-fidelity OCR of document/contract/agreement
      // 2. Extract all clauses with focus on:
      //    - Non-compete clauses
      //    - Auto-renewal terms
      //    - Hidden fees / penalty clauses
      //    - Liability limitations
      //    - Data sharing / privacy terms
      //    - Cancellation terms
      // 3. Compare to standard industry terms
      // 4. Flag concerning clauses with plain-language explanation
      // 5. TTS: "This contract has 3 concerning clauses: [summary]. The auto-renewal
      //          in section 14 locks you in for 24 months with a $500 early termination fee."
      return 'Reviewing contract. Extracting clauses and flagging concerning terms — auto-renewal, hidden fees, non-compete, liability limits.';
    }

    case 'device_check': {
      // TODO: Vision model analysis for hardware tampering
      // ATM card readers, USB devices, modified terminals
      return 'Checking device for tampering or suspicious modifications.';
    }

    case 'network_check': {
      // TODO: Wi-Fi SSID analysis — compare visible networks to known legitimate ones
      return 'Analyzing visible Wi-Fi networks for spoofing or suspicious activity.';
    }

    default:
      return `Security agent received task: "${task}". Processing.`;
  }
}

/**
 * Feature 5: Covert Meeting Intelligence
 *
 * Pipeline:
 *   START: begin audio capture (continuous STT + speaker diarization) +
 *          periodic visual capture (every 60-90s, change detection)
 *   DURING: real-time tracking of agenda, action items, decisions, open questions
 *   END: synthesize full summary — transcript, action items, decisions, slide captures
 *
 * Audio: Whisper or Deepgram Nova-3 for STT + speaker diarization
 * Visual: Change detection (only store when content changes significantly)
 */
async function handleMeeting(task: string, intent: string): Promise<string> {
  logger.info({ intent }, 'Meeting intelligence agent handling');

  switch (intent) {
    case 'start_meeting': {
      // TODO: Pipeline implementation
      // 1. Begin continuous audio capture → STT pipeline (Deepgram Nova-3 or Whisper)
      // 2. Enable speaker diarization (who said what)
      // 3. Start periodic visual capture (every 60-90 seconds)
      //    - Change detection: only store when visual content changes significantly
      //    - Focus on: slides, whiteboards, shared screens, documents
      //    - OCR all captured visuals
      // 4. Real-time processing:
      //    - Track agenda items
      //    - Flag action items ("I'll do X by Friday" → action item)
      //    - Track decisions ("We decided to go with option A")
      //    - Note unanswered questions
      // 5. Set session state
      activeSessions.set('meeting', {
        agent: 'meeting',
        startedAt: Date.now(),
        metadata: { topic: extractMeetingTopic(task) },
      });
      return 'Meeting mode activated. Recording audio with speaker diarization and capturing slides/whiteboards. Say "end meeting" when done.';
    }

    case 'end_meeting': {
      // TODO: Pipeline implementation
      // 1. Stop audio capture + visual capture
      // 2. Post-meeting synthesis:
      //    - Full transcript with speaker labels
      //    - Executive summary (3-5 sentences)
      //    - Action items with owner + deadline
      //    - Decisions made
      //    - Open questions
      //    - Slide/whiteboard captures with context
      // 3. Generate markdown summary
      // 4. Store in memory agent (Feature 1)
      // 5. Optional: email summary to attendees, create tasks in PM tool
      const session = activeSessions.get('meeting');
      const duration = session ? Math.round((Date.now() - session.startedAt) / 60000) : 0;
      activeSessions.delete('meeting');
      return `Meeting ended. Duration: ${duration} minutes. Generating summary with transcript, action items, decisions, and captured slides.`;
    }

    case 'query_meeting': {
      // TODO: Query the current or recent meeting data
      // "What did Mike commit to?" → search action items for speaker:Mike
      // "What was decided about pricing?" → search decisions for keyword:pricing
      return 'Searching meeting notes. Looking through transcripts, action items, and decisions.';
    }

    case 'meeting_summary': {
      // TODO: Generate/retrieve summary of last meeting
      return 'Retrieving meeting summary with action items and key decisions.';
    }

    default:
      return `Meeting intelligence agent received task: "${task}". Processing.`;
  }
}

/**
 * Feature 6: Hands-Free Debugging
 *
 * Pipeline: camera_snap (of screen) → vision model OCR with high fidelity →
 *           code analysis agent (identify language, parse error, generate fix) →
 *           TTS response: "[Problem]. [Fix]. [Any related concerns]."
 *
 * Supports: stack traces, code, config files, log output, terminal output, API responses
 * Key feature: multi-snap stitching for long errors + context accumulation
 */
async function handleDebug(task: string, intent: string): Promise<string> {
  logger.info({ intent }, 'Debug agent handling');

  switch (intent) {
    case 'debug_code': {
      // TODO: Pipeline implementation
      // 1. camera_snap → vision model extracts code/error text with high fidelity
      //    - Handle screen glare, angle, resolution variations
      //    - Multi-snap stitching if error doesn't fit one frame
      // 2. Code analysis:
      //    - Identify language/framework from syntax
      //    - Parse error message structure
      //    - Identify root cause
      //    - Generate fix with explanation
      //    - Check for related/cascading issues
      // 3. Context accumulation: remember previous snaps in this debug session
      //    so user can say "scroll down" + snap and maintain context
      // 4. TTS: "That's a null pointer in your auth middleware at line 47.
      //          You're not checking if the session exists before accessing user.id.
      //          Add a null check: if (!session?.user) return res.status(401)."
      return 'Analyzing code on screen. Extracting text, identifying language, and diagnosing the issue.';
    }

    case 'read_screen': {
      // TODO: General screen reading — extract all visible text
      // Useful for reading someone else's screen at a meetup, reading docs, etc.
      return 'Reading screen content. Extracting all visible text and code.';
    }

    case 'explain_error': {
      // TODO: Focus specifically on error messages
      // Parse error → explain in plain language → suggest fix
      return 'Analyzing error message. Identifying root cause and generating fix.';
    }

    case 'code_review': {
      // TODO: Review visible code for issues, improvements, security concerns
      return 'Reviewing visible code. Checking for bugs, security issues, and improvement opportunities.';
    }

    default:
      return `Debug agent received task: "${task}". Processing.`;
  }
}

/**
 * Feature 7: Automated Inspections / Documentation
 *
 * Pipeline:
 *   START: begin auto-snap every 10-15 seconds while walking
 *   DURING: vision model analyzes each snap per inspection type +
 *           voice annotations tagged to current snap
 *   END: generate professional PDF report with photos + findings
 *
 * Types: property, server-room, construction, warehouse, retail-inventory, general
 */
async function handleInspection(task: string, intent: string): Promise<string> {
  logger.info({ intent }, 'Inspection agent handling');

  switch (intent) {
    case 'start_inspection': {
      const inspectionType = extractInspectionType(task);

      // For retail-inventory type, start an inventory session
      if (inspectionType === 'retail-inventory') {
        const storeName = extractStoreName(task) || 'Store';
        const existing = getActiveInventory();
        if (existing) {
          return `Inventory session already active for "${existing.storeName}" (${existing.totalItems} items). Say "end inspection" to finish it first.`;
        }
        const session = startInventory(storeName);
        activeSessions.set('inspection', {
          agent: 'inspection',
          startedAt: Date.now(),
          metadata: { type: inspectionType, sessionId: session.id, snapCount: 0, itemCount: 0, flags: [] },
        });
        return `Inventory session started for "${storeName}". Walk the aisles — I'll auto-scan barcodes and count products. Say "aisle 3" to set your location. Say "end inspection" when done.`;
      }

      // Non-inventory inspection types (property, server room, etc.)
      activeSessions.set('inspection', {
        agent: 'inspection',
        startedAt: Date.now(),
        metadata: { type: inspectionType, snapCount: 0, itemCount: 0, flags: [] },
      });
      return `Inspection started: ${inspectionType}. Auto-capturing every 10 seconds. Use voice to annotate: "Note: [observation]". Say "end inspection" when done.`;
    }

    case 'end_inspection': {
      const session = activeSessions.get('inspection');
      const type = (session?.metadata?.type as string) || 'general';

      // For retail-inventory, end the inventory session and generate summary
      if (type === 'retail-inventory' && session?.metadata?.sessionId) {
        const inv = getActiveInventory();
        if (inv) {
          const summary = endInventory(inv.id);
          const csvPath = exportToCsv(summary);
          const ttsSummary = generateTtsSummary(summary);
          activeSessions.delete('inspection');
          logger.info({ sessionId: inv.id, items: summary.session.totalItems }, 'Inventory session ended');
          return `${ttsSummary} CSV exported to ${csvPath}. Access the full report via the dashboard.`;
        }
      }

      const duration = session ? Math.round((Date.now() - session.startedAt) / 60000) : 0;
      activeSessions.delete('inspection');
      return `Inspection complete: ${type}. Duration: ${duration} minutes. Generating report with all captured images, findings, and annotations. Export options: PDF, CSV, Google Sheets.`;
    }

    case 'annotate': {
      // For inventory sessions, treat voice annotation as a note
      const inv = getActiveInventory();
      if (inv) {
        const noteText = task.replace(/^note:?\s*/i, '').trim();
        if (noteText) addNote(inv.id, noteText);
        return 'Note recorded and tagged to current aisle.';
      }
      return 'Annotation recorded and tagged to current capture.';
    }

    case 'scan_item': {
      // Handle barcode scan or manual item add during inventory
      const inv = getActiveInventory();
      if (!inv) {
        return 'No active inventory session. Say "start inventory" to begin.';
      }
      const upc = extractUpc(task);
      if (upc) {
        const product = await lookupUpc(upc);
        const item = addItem(inv.id, {
          upc,
          name: product?.name || `Unknown Product (${upc})`,
          category: product?.category || null,
          quantity: 1,
          confidence: product ? 0.9 : 0.5,
          aisle: inv.currentAisle || 'unknown',
          shelf: null,
          position: null,
          price: product?.averagePrice || null,
          photoRef: null,
          method: 'barcode',
          flags: product ? [] : ['manual_verify'],
        });
        recordImageCapture(inv.id);
        return `Scanned: ${item.name}${product?.brand ? ` (${product.brand})` : ''}. Quantity: ${item.quantity}. ${getProgressStats(inv.id)}`;
      }
      return 'No barcode detected. Try again or say the product name to add manually.';
    }

    case 'set_aisle': {
      const inv = getActiveInventory();
      if (!inv) return 'No active inventory session.';
      const aisle = extractAisle(task);
      if (aisle) {
        setCurrentAisle(inv.id, aisle);
        return `Now scanning aisle ${aisle}.`;
      }
      return 'Which aisle? Say "aisle 3" or "aisle dairy".';
    }

    case 'generate_report': {
      const inv = getActiveInventory();
      if (inv) {
        return `Session still active with ${inv.totalItems} items. ${getProgressStats(inv.id)} Say "end inspection" to generate the final report.`;
      }
      return 'No active session. Start an inventory first.';
    }

    default:
      return `Inspection agent received task: "${task}". Processing.`;
  }
}

/**
 * Feature 8: Context-Aware Assistant
 *
 * Pipeline: camera_snap → context detection (what situation am I in?) →
 *           specialized response based on context + user preferences →
 *           brief TTS delivery (5-10 seconds max)
 *
 * Context sources: recent snaps (activity inference), calendar, user preferences
 * Contexts: kitchen/cooking, workshop/garage, grocery, gym, outdoors, museum, general
 */
async function handleContext(task: string, intent: string): Promise<string> {
  logger.info({ intent }, 'Context-aware assistant handling');

  switch (intent) {
    case 'identify_object': {
      // TODO: Pipeline implementation
      // 1. camera_snap → vision model identifies the object
      // 2. Detect current context from recent snap history:
      //    - Kitchen → recipe assistant mode (ingredient ID, measurements)
      //    - Workshop → tool/parts identifier (bolt sizes, torque specs)
      //    - Grocery → nutrition + price comparison mode
      //    - Gym → exercise form + program mode
      //    - Outdoors → plant/animal/terrain identification
      //    - Museum → artwork/exhibit information
      // 3. Cross-reference with user preferences (dietary restrictions, fitness goals, etc.)
      // 4. Brief TTS delivery (5-10 seconds max):
      //    Kitchen: "That's cardamom. Your recipe calls for 1 tsp."
      //    Workshop: "That's an M8 x 1.25 hex bolt. Torque spec: 25 Nm."
      //    Grocery: "That has 42g sugar per serving. Your daily target is 25g."
      return 'Identifying object in context. Analyzing what you\'re looking at and providing relevant information based on your current activity.';
    }

    case 'contextual_help': {
      // TODO: General "help" — infer what the user needs based on visual context
      // e.g., looking at a complex appliance → show usage instructions
      // e.g., looking at a recipe → read next step
      return 'Analyzing your current context to provide relevant help.';
    }

    case 'step_guide': {
      // TODO: "How do I..." — provide step-by-step guidance
      // Cross-reference visible objects with instructions
      // e.g., "How do I use this?" while looking at a coffee machine
      return 'Generating step-by-step guide based on what you\'re looking at.';
    }

    case 'nutrition_check': {
      // TODO: Nutrition label reading + dietary preference cross-reference
      // Extract: calories, sugar, sodium, allergens
      // Compare to user's dietary goals/restrictions
      return 'Reading nutrition information and comparing to your dietary preferences.';
    }

    default:
      return `Context-aware assistant received task: "${task}". Processing.`;
  }
}

/**
 * Feature 9: Deep Translation + Cultural Intel
 *
 * Pipeline: camera_snap → OCR + language detection → translation + cultural context →
 *           TTS delivery in preferred language
 *
 * Modes: quick (just translation), full (translation + cultural notes),
 *        conversation (continuous), cultural coach (real-time etiquette)
 */
async function handleTranslation(task: string, intent: string): Promise<string> {
  logger.info({ intent }, 'Translation agent handling');

  switch (intent) {
    case 'translate_text': {
      // TODO: Pipeline implementation
      // 1. camera_snap → OCR text extraction
      // 2. Language detection (auto-detect source language)
      // 3. Translation to user's preferred language
      // 4. For menus/signs: add context (dish descriptions, local meaning)
      // 5. TTS delivery in preferred language
      return 'Translating text from image. Detecting language and providing translation with context.';
    }

    case 'cultural_context': {
      // TODO: Location-aware cultural coaching
      // Based on GPS + detected language/setting:
      // - Business etiquette (card exchange customs, greeting norms)
      // - Dining customs (tipping, ordering, seating)
      // - Local tips and recommendations
      return 'Providing cultural context and etiquette guidance for your current location.';
    }

    case 'conversation_translate': {
      // TODO: Continuous translation mode
      // Real-time audio → STT → detect language → translate → TTS
      // For live conversations with non-shared language
      return 'Conversation translation mode. Listening and translating in real-time.';
    }

    case 'language_detect': {
      // TODO: Identify the language in the image or audio
      return 'Detecting language from visible text or audio.';
    }

    default:
      return `Translation agent received task: "${task}". Processing.`;
  }
}

/**
 * Feature 10: Context Chains
 *
 * Chains combine multiple agents into intelligent workflows:
 *   - Sales Meeting Chain: pre-meeting research → live transcription → post-meeting summary
 *   - Shopping Trip Chain: shopping list → price comparison → receipt logging
 *   - Travel Chain: translation → cultural briefing → POI identification
 *
 * Triggers: calendar events, GPS location changes, voice commands, time-based
 */
async function handleChain(task: string, intent: string): Promise<string> {
  logger.info({ intent }, 'Context chain engine handling');

  switch (intent) {
    case 'activate_chain': {
      // TODO: Pipeline implementation
      // 1. Parse chain type from task ("start sales mode", "shopping mode", "travel mode")
      // 2. Load chain configuration:
      //    {
      //      chain_name, triggers,
      //      phases: [
      //        { phase: "pre", timing, actions: ["research_attendees", "company_intel"] },
      //        { phase: "active", timing, actions: ["meeting_transcription", "slide_capture"] },
      //        { phase: "post", timing, actions: ["generate_summary", "extract_actions"] }
      //      ]
      //    }
      // 3. Activate phase 1 agents
      // 4. Set up auto-transitions between phases
      const chainType = extractChainType(task);
      activeSessions.set('chain', {
        agent: 'chain',
        startedAt: Date.now(),
        metadata: { type: chainType, phase: 'pre', activeAgents: [] },
      });
      return `${chainType} chain activated. Running pre-phase preparation. Agents will transition automatically through each phase.`;
    }

    case 'deactivate_chain': {
      const session = activeSessions.get('chain');
      const chainType = (session?.metadata?.type as string) || 'unknown';
      activeSessions.delete('chain');
      return `${chainType} chain deactivated. All chained agents stopped.`;
    }

    case 'chain_status': {
      const session = activeSessions.get('chain');
      if (!session) return 'No active chain. Start one with "start [sales/shopping/travel] mode".';
      const elapsed = Math.round((Date.now() - session.startedAt) / 60000);
      return `Active chain: ${session.metadata.type}. Phase: ${session.metadata.phase}. Running for ${elapsed} minutes.`;
    }

    default:
      return `Chain engine received task: "${task}". Processing.`;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  CORE AGENTS (original — with expanded TODO notes)
// ═══════════════════════════════════════════════════════════════════

async function handleComms(task: string, intent: string): Promise<string> {
  logger.info({ intent }, 'Comms agent handling');
  // TODO: Integrate with Telegram Bot API, WhatsApp Business API, etc.
  return `Communication task received: "${task}". Awaiting confirmation before sending.`;
}

async function handleResearch(task: string, intent: string): Promise<string> {
  logger.info({ intent }, 'Research agent handling');
  // TODO: Integrate with Brave Search API, Wikipedia, news APIs
  return `Research task queued: "${task}". Integration point for web search, Wikipedia, news APIs.`;
}

async function handleOps(task: string, intent: string): Promise<string> {
  logger.info({ intent }, 'Ops agent handling');
  // TODO: Integrate with calendar APIs, reminder systems, note-taking apps
  return `Ops task processed: "${task}". Integration point for calendar, reminders, notes, lists.`;
}

async function handleSmartHome(task: string, intent: string): Promise<string> {
  logger.info({ intent }, 'Smart home agent handling');
  // TODO: Integrate with Home Assistant, SmartThings, etc.
  return `Smart home command received: "${task}". Integration point for Home Assistant/SmartThings.`;
}

async function handleGeneral(task: string, intent: string): Promise<string> {
  logger.info({ intent }, 'Siberius general agent handling');
  return `Task received by Siberius: "${task}". Processing via default agent.`;
}

// ═══════════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

/** Extract meeting topic from task string */
function extractMeetingTopic(task: string): string {
  // Try to extract topic from patterns like "start meeting about X" or "meeting: X"
  const topicMatch = task.match(/(?:meeting (?:about|on|for|re:?)\s+)(.+)/i)
    || task.match(/(?:meeting:\s*)(.+)/i);
  return topicMatch ? topicMatch[1].trim() : 'Untitled Meeting';
}

/** Extract inspection type from task string */
function extractInspectionType(task: string): string {
  const typeMap: Record<string, string> = {
    'property': 'property',
    'rental': 'property',
    'apartment': 'property',
    'house': 'property',
    'server': 'server-room',
    'rack': 'server-room',
    'data center': 'server-room',
    'construction': 'construction',
    'site': 'construction',
    'warehouse': 'warehouse',
    'storage': 'warehouse',
    'inventory': 'retail-inventory',
    'store': 'retail-inventory',
    'retail': 'retail-inventory',
    'shop': 'retail-inventory',
  };

  const lower = task.toLowerCase();
  for (const [keyword, type] of Object.entries(typeMap)) {
    if (lower.includes(keyword)) return type;
  }
  return 'general';
}

/** Extract store name from task string (e.g., "start inventory at Costco" → "Costco") */
function extractStoreName(task: string): string | null {
  const match = task.match(/(?:at|for|in)\s+(?:the\s+)?(.+?)(?:\s+store)?$/i);
  return match ? match[1].trim() : null;
}

/** Extract UPC/barcode from task string */
function extractUpc(task: string): string | null {
  const match = task.match(/\b(\d{8,14})\b/);
  return match ? match[1] : null;
}

/** Extract aisle identifier from task string */
function extractAisle(task: string): string | null {
  const match = task.match(/aisle\s+(.+?)(?:\s|$)/i);
  return match ? match[1].trim() : null;
}

/** Extract chain type from task string */
function extractChainType(task: string): string {
  const lower = task.toLowerCase();
  if (/sales|meeting|pitch|client/.test(lower)) return 'sales-meeting';
  if (/shop|store|grocery|retail/.test(lower)) return 'shopping-trip';
  if (/travel|trip|abroad|international|tour/.test(lower)) return 'travel';
  return 'general';
}

// ═══════════════════════════════════════════════════════════════════
//  SESSION MANAGEMENT (for stateful agents)
// ═══════════════════════════════════════════════════════════════════

/** Get the currently active session for a given agent type */
export function getActiveSession(agent: AgentType): ActiveSession | undefined {
  return activeSessions.get(agent);
}

/** Check if any stateful agent session is currently active */
export function hasActiveSessions(): boolean {
  return activeSessions.size > 0;
}

/** Get all active sessions (for status/health endpoint) */
export function getActiveSessions(): Record<string, { agent: AgentType; startedAt: number; metadata: Record<string, unknown> }> {
  const result: Record<string, { agent: AgentType; startedAt: number; metadata: Record<string, unknown> }> = {};
  for (const [key, session] of activeSessions) {
    result[key] = { agent: session.agent, startedAt: session.startedAt, metadata: session.metadata };
  }
  return result;
}
