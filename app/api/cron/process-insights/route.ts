import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { db } from "@/lib/db";
import {
  entities,
  goals,
  emotionalLogs,
  callbacks,
} from "@/lib/db/schema";
import {
  getConversationsNeedingInsightProcessing,
  getMessages,
  getActiveInsights,
  markConversationProcessed,
  upsertInsight,
  updateInsight,
  deactivateInsight,
} from "@/lib/db/queries";
import { eq, and } from "drizzle-orm";

const MAX_CONVERSATIONS_PER_RUN = 50;

// ---------------------------------------------------------------------------
// Enhanced extraction prompt — extracts entities, goals, emotions, callbacks,
// and insights from each conversation batch.
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are an advanced memory extraction system for Neroli, an AI companion for men navigating dating, relationships, fitness, career, and personal growth.

Analyze the conversation below and extract ALL of the following structured data. Compare with any existing data provided so you avoid duplicates and correctly update existing records.

## 1. Entities (People in the user's life)

Extract every person the user mentions: matches, dates, partners, exes, friends, family, coworkers, therapists, etc.

For each entity include:
- "name": The person's name (first name is fine)
- "type": one of "match" | "date" | "partner" | "ex" | "friend" | "family" | "coworker" | "therapist" | "other"
- "platform": if applicable, one of "hinge" | "tinder" | "bumble" | "irl" | null
- "status": one of "active" | "inactive" | "ended" | "unknown"
- "notes": A concise summary of what the user said about this person. Include specific details (where they met, what happened, physical descriptions, personality traits, key events).

## 2. Goals (Explicit or implicit user goals)

Extract goals the user has stated or strongly implied.

For each goal include:
- "category": one of "dating" | "fitness" | "career" | "social" | "style" | "health" | "personal"
- "title": Short description of the goal
- "source": "explicit" (user directly stated it) | "inferred" (strongly implied from context)
- "confidence": 0.5-1.0

## 3. Emotional State

Assess the user's emotional state in this conversation.

- "valence": -1.0 (very negative) to 1.0 (very positive)
- "arousal": 0.0 (calm) to 1.0 (activated/excited)
- "dominantEmotion": one of "happy" | "sad" | "anxious" | "angry" | "hopeful" | "frustrated" | "excited" | "neutral" | "heartbroken" | "confident" | "lonely" | "grateful"
- "triggers": What caused this emotional state (brief)

## 4. Callbacks (Things to follow up on)

Extract things Neroli should follow up on in future conversations. These are events, dates, plans, deadlines, or situations that warrant a check-in.

For each callback include:
- "content": What to follow up on (e.g., "Jake had a date with Sarah on Friday -- ask how it went")
- "triggerType": one of "date_event" | "time_based" | "goal_check" | "emotional_check" | "milestone"
- "triggerAt": ISO timestamp of when to trigger (estimate if needed; use null if uncertain)
- "priority": "high" | "medium" | "low"

## 5. Insights (General knowledge about the user)

Same as before — extract preferences, personality traits, life context, and milestones.

- "type": one of "life_state" | "goal" | "preference" | "personality" | "context" | "person" | "milestone" | "relationship"
- "content": Concise, specific insight
- "confidence": 0.5-1.0

## 6. Entity Updates (Changes to existing entities)

If existing entities have new information, provide updates.

- "name": The entity name to update (must match an existing entity)
- "updates": Object with any fields to change: { "status"?, "notes"?, "type"?, "platform"? }

## 7. Goal Updates (Changes to existing goals)

If existing goals have progress or status changes, provide updates.

- "title": The goal title to update (must match an existing goal)
- "updates": Object with any fields to change: { "status"?, "progress"? }

## 8. Insight Updates and Deactivations

Same as the current system for backward compatibility.

## Rules

1. Only extract data clearly supported by the conversation. Do not speculate.
2. Be concise but specific — include names, dates, and details when available.
3. For entities, always include enough notes to understand the relationship context.
4. For callbacks, think about what a good friend would remember to ask about.
5. For emotions, focus on the USER's emotional state, not the people they mention.
6. Do NOT create duplicate entities — if an existing entity matches, put it in entityUpdates instead.
7. Do NOT create duplicate goals — if an existing goal matches, put it in goalUpdates instead.
8. If an insight is outdated or contradicted, include it in "insightDeactivations" with its ID.
9. If an insight needs updating, include it in "insightUpdates" with its ID and new content.

## Response Format

Respond with ONLY a JSON object (no markdown fences, no explanation):

{
  "entities": [
    { "name": "Sarah", "type": "match", "platform": "hinge", "status": "active", "notes": "Veterinary student, first date at coffee shop, seemed interested" }
  ],
  "goals": [
    { "category": "dating", "title": "Get 3 dates this month", "source": "explicit", "confidence": 0.9 }
  ],
  "emotion": {
    "valence": 0.3,
    "arousal": 0.6,
    "dominantEmotion": "anxious",
    "triggers": "Sarah hasn't texted back after the date"
  },
  "callbacks": [
    { "content": "Jake had a date with Sarah on Friday -- ask how it went", "triggerType": "date_event", "triggerAt": "2026-02-28T20:00:00Z", "priority": "high" }
  ],
  "insights": [
    { "type": "preference", "content": "Prefers bourbon Old Fashioneds", "confidence": 0.7 }
  ],
  "entityUpdates": [
    { "name": "Sarah", "updates": { "status": "inactive", "notes": "Stopped responding after first date" } }
  ],
  "goalUpdates": [
    { "title": "Get 3 dates this month", "updates": { "progress": "2 out of 3 dates completed" } }
  ],
  "insightUpdates": [
    { "id": "existing-insight-uuid", "content": "Updated content here", "confidence": 0.85 }
  ],
  "insightDeactivations": ["insight-uuid-to-deactivate"]
}

If a section has no data, use an empty array (or omit for emotion). Example minimal response:
{ "entities": [], "goals": [], "callbacks": [], "insights": [], "entityUpdates": [], "goalUpdates": [], "insightUpdates": [], "insightDeactivations": [] }`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtractedEntity {
  name: string;
  type: string;
  platform?: string | null;
  status: string;
  notes: string;
}

interface ExtractedGoal {
  category: string;
  title: string;
  source: string;
  confidence: number;
}

interface ExtractedEmotion {
  valence: number;
  arousal: number;
  dominantEmotion: string;
  triggers?: string;
}

interface ExtractedCallback {
  content: string;
  triggerType: string;
  triggerAt?: string | null;
  priority: string;
}

interface ExtractedInsight {
  type: string;
  content: string;
  confidence: number;
}

interface ExtractedEntityUpdate {
  name: string;
  updates: {
    status?: string;
    notes?: string;
    type?: string;
    platform?: string;
  };
}

interface ExtractedGoalUpdate {
  title: string;
  updates: {
    status?: string;
    progress?: string;
  };
}

interface InsightUpdate {
  id: string;
  content: string;
  confidence: number;
}

interface ExtractionResult {
  entities: ExtractedEntity[];
  goals: ExtractedGoal[];
  emotion?: ExtractedEmotion | null;
  callbacks: ExtractedCallback[];
  insights: ExtractedInsight[];
  entityUpdates: ExtractedEntityUpdate[];
  goalUpdates: ExtractedGoalUpdate[];
  insightUpdates: InsightUpdate[];
  insightDeactivations: string[];
}

// ---------------------------------------------------------------------------
// Stats tracking
// ---------------------------------------------------------------------------

interface ProcessingStats {
  insightsCreated: number;
  insightsUpdated: number;
  insightsDeactivated: number;
  entitiesCreated: number;
  entitiesUpdated: number;
  goalsCreated: number;
  goalsUpdated: number;
  emotionsLogged: number;
  callbacksCreated: number;
}

function emptyStats(): ProcessingStats {
  return {
    insightsCreated: 0,
    insightsUpdated: 0,
    insightsDeactivated: 0,
    entitiesCreated: 0,
    entitiesUpdated: 0,
    goalsCreated: 0,
    goalsUpdated: 0,
    emotionsLogged: 0,
    callbacksCreated: 0,
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  let processed = 0;
  const stats = emptyStats();
  const errors: string[] = [];

  try {
    const conversationsToProcess =
      await getConversationsNeedingInsightProcessing(MAX_CONVERSATIONS_PER_RUN);

    for (const conversation of conversationsToProcess) {
      try {
        // Fetch messages, existing insights, existing entities, and existing goals in parallel
        const [messageRows, existingInsights, existingEntities, existingGoals] =
          await Promise.all([
            getMessages(conversation.id),
            getActiveInsights(conversation.userId),
            getActiveEntitiesForUser(conversation.userId),
            getActiveGoalsForUser(conversation.userId),
          ]);

        // Skip conversations with very few messages (not enough signal)
        if (messageRows.length < 3) {
          await markConversationProcessed(conversation.id);
          processed++;
          continue;
        }

        // Format messages for the prompt
        const formattedMessages = messageRows
          .map((m) => `[${m.role}]: ${m.content}`)
          .join("\n\n");

        // Format existing data for context
        const formattedInsights =
          existingInsights.length > 0
            ? existingInsights
                .map(
                  (i) =>
                    `- [${i.id}] (${i.type}) ${i.content} (confidence: ${i.confidence})`
                )
                .join("\n")
            : "None yet.";

        const formattedEntities =
          existingEntities.length > 0
            ? existingEntities
                .map(
                  (e) =>
                    `- ${e.name} (${e.type}${e.platform ? `, ${e.platform}` : ""}, ${e.status}): ${e.notes ?? "no notes"}`
                )
                .join("\n")
            : "None yet.";

        const formattedGoals =
          existingGoals.length > 0
            ? existingGoals
                .map(
                  (g) =>
                    `- [${g.category}] ${g.title} (${g.status}${g.progress ? `, ${g.progress}` : ""})`
                )
                .join("\n")
            : "None yet.";

        const userPrompt = `## Existing Insights for This User

${formattedInsights}

## Existing Entities (People) for This User

${formattedEntities}

## Existing Goals for This User

${formattedGoals}

## Conversation

${formattedMessages}`;

        // Call Gemini for extraction
        const { text } = await generateText({
          model: google("gemini-2.5-flash"),
          system: EXTRACTION_PROMPT,
          prompt: userPrompt,
        });

        // Parse the response
        const result = parseExtractionResult(text);
        if (!result) {
          errors.push(
            `Failed to parse extraction result for conversation ${conversation.id}`
          );
          await markConversationProcessed(conversation.id);
          processed++;
          continue;
        }

        // Process all extracted data
        await processExtraction(
          result,
          conversation.userId,
          conversation.id,
          existingInsights,
          existingEntities,
          existingGoals,
          stats
        );

        await markConversationProcessed(conversation.id);
        processed++;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error";
        errors.push(`Conversation ${conversation.id}: ${message}`);
        // Continue processing other conversations
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      {
        success: false,
        error: message,
        processed,
        ...stats,
      },
      { status: 500 }
    );
  }

  const durationMs = Date.now() - startTime;

  return NextResponse.json({
    success: true,
    processed,
    ...stats,
    errors: errors.length > 0 ? errors : undefined,
    durationMs,
  });
}

// ---------------------------------------------------------------------------
// Data processing — write all extracted data to the database
// ---------------------------------------------------------------------------

async function processExtraction(
  result: ExtractionResult,
  userId: string,
  conversationId: string,
  existingInsights: Array<{ id: string; type: string; content: string; confidence: number | null }>,
  existingEntities: Array<{ id: string; name: string; type: string; platform: string | null; status: string; notes: string | null }>,
  existingGoals: Array<{ id: string; category: string; title: string; status: string; progress: string | null }>,
  stats: ProcessingStats
): Promise<void> {
  // --- 1. Process new entities ---
  await processNewEntities(result.entities, userId, existingEntities, stats);

  // --- 2. Process entity updates ---
  await processEntityUpdates(result.entityUpdates, userId, existingEntities, stats);

  // --- 3. Process new goals ---
  await processNewGoals(result.goals, userId, existingGoals, stats);

  // --- 4. Process goal updates ---
  await processGoalUpdates(result.goalUpdates, userId, existingGoals, stats);

  // --- 5. Log emotional state ---
  if (result.emotion) {
    await logEmotionalState(result.emotion, userId, conversationId, stats);
  }

  // --- 6. Create callbacks ---
  await processCallbacks(result.callbacks, userId, conversationId, stats);

  // --- 7. Process new insights ---
  await processNewInsights(result.insights, userId, stats);

  // --- 8. Process insight updates ---
  await processInsightUpdates(result.insightUpdates, existingInsights, stats);

  // --- 9. Process insight deactivations ---
  await processInsightDeactivations(result.insightDeactivations, existingInsights, stats);
}

// ---------------------------------------------------------------------------
// Entity processing
// ---------------------------------------------------------------------------

const VALID_ENTITY_TYPES = [
  "match", "date", "partner", "ex", "friend", "family",
  "coworker", "therapist", "other",
];

const VALID_ENTITY_PLATFORMS = ["hinge", "tinder", "bumble", "irl"];

const VALID_ENTITY_STATUSES = ["active", "inactive", "ended", "unknown"];

async function processNewEntities(
  extracted: ExtractedEntity[],
  userId: string,
  existingEntities: Array<{ name: string }>,
  stats: ProcessingStats
): Promise<void> {
  for (const entity of extracted) {
    if (!entity.name || entity.name.trim().length === 0) continue;
    if (!VALID_ENTITY_TYPES.includes(entity.type)) continue;

    // Check if entity already exists (case-insensitive match)
    const nameNormalized = entity.name.trim().toLowerCase();
    const exists = existingEntities.some(
      (e) => e.name.toLowerCase() === nameNormalized
    );
    if (exists) continue; // Skip — should be handled as an update

    const platform =
      entity.platform && VALID_ENTITY_PLATFORMS.includes(entity.platform)
        ? entity.platform
        : null;
    const status = VALID_ENTITY_STATUSES.includes(entity.status)
      ? entity.status
      : "unknown";

    await db.insert(entities).values({
      userId,
      name: entity.name.trim(),
      type: entity.type,
      platform,
      status,
      notes: entity.notes?.trim() || null,
    });
    stats.entitiesCreated++;
  }
}

async function processEntityUpdates(
  updates: ExtractedEntityUpdate[],
  userId: string,
  existingEntities: Array<{ id: string; name: string }>,
  stats: ProcessingStats
): Promise<void> {
  for (const update of updates) {
    if (!update.name || !update.updates) continue;

    // Find the matching existing entity (case-insensitive)
    const existing = existingEntities.find(
      (e) => e.name.toLowerCase() === update.name.trim().toLowerCase()
    );
    if (!existing) continue;

    const setFields: Record<string, unknown> = {
      lastMentionedAt: new Date(),
      updatedAt: new Date(),
    };

    if (
      update.updates.status &&
      VALID_ENTITY_STATUSES.includes(update.updates.status)
    ) {
      setFields.status = update.updates.status;
    }
    if (update.updates.notes) {
      setFields.notes = update.updates.notes.trim();
    }
    if (
      update.updates.type &&
      VALID_ENTITY_TYPES.includes(update.updates.type)
    ) {
      setFields.type = update.updates.type;
    }
    if (
      update.updates.platform &&
      VALID_ENTITY_PLATFORMS.includes(update.updates.platform)
    ) {
      setFields.platform = update.updates.platform;
    }

    await db
      .update(entities)
      .set(setFields)
      .where(and(eq(entities.id, existing.id), eq(entities.userId, userId)));
    stats.entitiesUpdated++;
  }
}

// ---------------------------------------------------------------------------
// Goal processing
// ---------------------------------------------------------------------------

const VALID_GOAL_CATEGORIES = [
  "dating", "fitness", "career", "social", "style", "health", "personal",
];

const VALID_GOAL_SOURCES = ["explicit", "inferred", "suggested"];

async function processNewGoals(
  extracted: ExtractedGoal[],
  userId: string,
  existingGoals: Array<{ title: string }>,
  stats: ProcessingStats
): Promise<void> {
  for (const goal of extracted) {
    if (!goal.title || goal.title.trim().length === 0) continue;
    if (!VALID_GOAL_CATEGORIES.includes(goal.category)) continue;

    // Check for duplicate goals (fuzzy match — same category + similar title)
    const titleNormalized = goal.title.trim().toLowerCase();
    const exists = existingGoals.some(
      (g) => g.title.toLowerCase() === titleNormalized
    );
    if (exists) continue;

    const source = VALID_GOAL_SOURCES.includes(goal.source)
      ? goal.source
      : "inferred";
    const confidence = clampConfidence(goal.confidence);

    // Default check-in intervals based on category
    const defaultIntervals: Record<string, string> = {
      fitness: "weekly",
      dating: "weekly",
      career: "biweekly",
      health: "weekly",
      social: "biweekly",
      style: "monthly",
      personal: "biweekly",
    };

    await db.insert(goals).values({
      userId,
      category: goal.category,
      title: goal.title.trim(),
      source,
      confidence,
      checkInInterval: defaultIntervals[goal.category] ?? "weekly",
    });
    stats.goalsCreated++;
  }
}

async function processGoalUpdates(
  updates: ExtractedGoalUpdate[],
  userId: string,
  existingGoals: Array<{ id: string; title: string }>,
  stats: ProcessingStats
): Promise<void> {
  const VALID_GOAL_STATUSES = ["active", "completed", "paused", "abandoned"];

  for (const update of updates) {
    if (!update.title || !update.updates) continue;

    // Find matching goal (case-insensitive)
    const existing = existingGoals.find(
      (g) => g.title.toLowerCase() === update.title.trim().toLowerCase()
    );
    if (!existing) continue;

    const setFields: Record<string, unknown> = { updatedAt: new Date() };

    if (
      update.updates.status &&
      VALID_GOAL_STATUSES.includes(update.updates.status)
    ) {
      setFields.status = update.updates.status;
    }
    if (update.updates.progress) {
      setFields.progress = update.updates.progress.trim();
    }

    await db
      .update(goals)
      .set(setFields)
      .where(and(eq(goals.id, existing.id), eq(goals.userId, userId)));
    stats.goalsUpdated++;
  }
}

// ---------------------------------------------------------------------------
// Emotional state logging
// ---------------------------------------------------------------------------

const VALID_EMOTIONS = [
  "happy", "sad", "anxious", "angry", "hopeful", "frustrated",
  "excited", "neutral", "heartbroken", "confident", "lonely", "grateful",
];

async function logEmotionalState(
  emotion: ExtractedEmotion,
  userId: string,
  conversationId: string,
  stats: ProcessingStats
): Promise<void> {
  if (!VALID_EMOTIONS.includes(emotion.dominantEmotion)) return;

  const valence = Math.max(-1, Math.min(1, emotion.valence ?? 0));
  const arousal = Math.max(0, Math.min(1, emotion.arousal ?? 0.5));

  await db.insert(emotionalLogs).values({
    userId,
    conversationId,
    valence,
    arousal,
    dominantEmotion: emotion.dominantEmotion,
    triggers: emotion.triggers?.trim() || null,
  });
  stats.emotionsLogged++;
}

// ---------------------------------------------------------------------------
// Callback processing
// ---------------------------------------------------------------------------

const VALID_TRIGGER_TYPES = [
  "date_event", "time_based", "goal_check", "emotional_check", "milestone",
];

const VALID_PRIORITIES = ["high", "medium", "low"];

async function processCallbacks(
  extracted: ExtractedCallback[],
  userId: string,
  conversationId: string,
  stats: ProcessingStats
): Promise<void> {
  for (const callback of extracted) {
    if (!callback.content || callback.content.trim().length === 0) continue;

    const triggerType = VALID_TRIGGER_TYPES.includes(callback.triggerType)
      ? callback.triggerType
      : "time_based";
    const priority = VALID_PRIORITIES.includes(callback.priority)
      ? callback.priority
      : "medium";

    let triggerAt: Date | null = null;
    if (callback.triggerAt) {
      const parsed = new Date(callback.triggerAt);
      if (!isNaN(parsed.getTime())) {
        triggerAt = parsed;
      }
    }

    // If no trigger time provided, default to 24 hours from now
    if (!triggerAt) {
      triggerAt = new Date(Date.now() + 86_400_000);
    }

    await db.insert(callbacks).values({
      userId,
      content: callback.content.trim(),
      triggerType,
      triggerAt,
      priority,
      sourceConversationId: conversationId,
    });
    stats.callbacksCreated++;
  }
}

// ---------------------------------------------------------------------------
// Insight processing (same as before, with enhanced types)
// ---------------------------------------------------------------------------

const VALID_INSIGHT_TYPES = [
  "life_state", "goal", "preference", "personality",
  "context", "person", "milestone", "relationship",
];

async function processNewInsights(
  extracted: ExtractedInsight[],
  userId: string,
  stats: ProcessingStats
): Promise<void> {
  for (const insight of extracted) {
    if (!VALID_INSIGHT_TYPES.includes(insight.type)) continue;
    if (!insight.content || insight.content.trim().length === 0) continue;

    const confidence = clampConfidence(insight.confidence);

    await upsertInsight({
      userId,
      type: insight.type,
      content: insight.content.trim(),
      confidence,
    });
    stats.insightsCreated++;
  }
}

async function processInsightUpdates(
  updates: InsightUpdate[],
  existingInsights: Array<{ id: string }>,
  stats: ProcessingStats
): Promise<void> {
  for (const update of updates) {
    if (!update.id || !update.content) continue;

    // Verify the insight exists in the provided set
    const existing = existingInsights.find((i) => i.id === update.id);
    if (!existing) continue;

    const confidence = clampConfidence(update.confidence);

    await updateInsight(update.id, {
      content: update.content.trim(),
      confidence,
    });
    stats.insightsUpdated++;
  }
}

async function processInsightDeactivations(
  deactivations: string[],
  existingInsights: Array<{ id: string }>,
  stats: ProcessingStats
): Promise<void> {
  for (const insightId of deactivations) {
    if (!insightId) continue;

    // Verify the insight exists
    const existing = existingInsights.find((i) => i.id === insightId);
    if (!existing) continue;

    await deactivateInsight(insightId);
    stats.insightsDeactivated++;
  }
}

// ---------------------------------------------------------------------------
// Helper: fetch active entities for a user
// ---------------------------------------------------------------------------

async function getActiveEntitiesForUser(userId: string) {
  return db
    .select()
    .from(entities)
    .where(and(eq(entities.userId, userId), eq(entities.active, true)));
}

// ---------------------------------------------------------------------------
// Helper: fetch active goals for a user
// ---------------------------------------------------------------------------

async function getActiveGoalsForUser(userId: string) {
  return db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.status, "active")));
}

// ---------------------------------------------------------------------------
// Parse the JSON extraction result from Gemini.
// Handles markdown fences, trailing commas, and other common LLM output quirks.
// ---------------------------------------------------------------------------

function parseExtractionResult(text: string): ExtractionResult | null {
  try {
    // Strip markdown code fences if present
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned
        .replace(/^```(?:json)?\s*\n?/, "")
        .replace(/\n?```\s*$/, "");
    }

    const parsed = JSON.parse(cleaned);

    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      goals: Array.isArray(parsed.goals) ? parsed.goals : [],
      emotion: parsed.emotion && typeof parsed.emotion === "object"
        ? parsed.emotion
        : null,
      callbacks: Array.isArray(parsed.callbacks) ? parsed.callbacks : [],
      insights: Array.isArray(parsed.insights) ? parsed.insights : [],
      entityUpdates: Array.isArray(parsed.entityUpdates)
        ? parsed.entityUpdates
        : [],
      goalUpdates: Array.isArray(parsed.goalUpdates)
        ? parsed.goalUpdates
        : [],
      insightUpdates: Array.isArray(parsed.insightUpdates)
        ? parsed.insightUpdates
        : [],
      insightDeactivations: Array.isArray(parsed.insightDeactivations)
        ? parsed.insightDeactivations
        : // Backward compatibility with old field name
          Array.isArray(parsed.deactivate)
          ? parsed.deactivate
          : [],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function clampConfidence(value: number | undefined | null): number {
  return Math.max(0.1, Math.min(1.0, value ?? 0.5));
}
