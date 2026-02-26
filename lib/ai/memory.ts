// ---------------------------------------------------------------------------
// Memory Assembly Pipeline
// The brain of Neroli's memory system. Assembles a rich context block for each
// chat turn so that Gemini has everything it needs to feel like it truly knows
// the user.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import {
  users,
  conversations,
  insights,
  entities,
  goals,
  emotionalLogs,
  callbacks,
} from "@/lib/db/schema";
import { eq, and, desc, lte, asc } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryContext {
  userProfile: {
    name?: string;
    lifeState?: string;
    socialStyle?: string;
    lifestyle?: string;
    personalityDigest?: string;
    goals?: string[];
    communicationStyle?: string;
    location?: string;
    age?: string;
    occupation?: string;
  };
  activeEntities: Array<{
    name: string;
    type: string;
    platform?: string | null;
    status: string;
    notes: string;
    lastMentioned: string;
  }>;
  activeGoals: Array<{
    title: string;
    category: string;
    status: string;
    progress?: string | null;
    dueForCheckIn: boolean;
  }>;
  emotionalState: {
    current: string; // latest dominant emotion
    trend: string; // "improving" | "declining" | "stable"
    recentEmotions: string[]; // last 3-5
  };
  pendingCallbacks: string[]; // things to follow up on this turn
  conversationSummary?: string;
  insights: string[];
}

// ---------------------------------------------------------------------------
// Data fetching helpers
// ---------------------------------------------------------------------------

async function getUserProfile(userId: string) {
  const [user] = await db
    .select({
      displayName: users.displayName,
      profile: users.profile,
      communicationStyle: users.communicationStyle,
    })
    .from(users)
    .where(eq(users.id, userId));
  return user ?? null;
}

async function getActiveEntities(userId: string) {
  return db
    .select()
    .from(entities)
    .where(and(eq(entities.userId, userId), eq(entities.active, true)))
    .orderBy(desc(entities.lastMentionedAt));
}

async function getActiveGoals(userId: string) {
  return db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.status, "active")))
    .orderBy(desc(goals.updatedAt));
}

async function getRecentEmotions(userId: string, limit: number = 6) {
  return db
    .select()
    .from(emotionalLogs)
    .where(eq(emotionalLogs.userId, userId))
    .orderBy(desc(emotionalLogs.createdAt))
    .limit(limit);
}

async function getTriggeredCallbacks(userId: string) {
  const now = new Date();
  return db
    .select()
    .from(callbacks)
    .where(
      and(
        eq(callbacks.userId, userId),
        eq(callbacks.status, "pending"),
        lte(callbacks.triggerAt, now)
      )
    )
    .orderBy(asc(callbacks.priority));
}

async function getConversationSummary(conversationId: string) {
  const [conv] = await db
    .select({ summary: conversations.summary })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return conv?.summary ?? undefined;
}

async function getActiveInsights(userId: string) {
  return db
    .select()
    .from(insights)
    .where(and(eq(insights.userId, userId), eq(insights.active, true)));
}

// ---------------------------------------------------------------------------
// Emotional trend analysis
// ---------------------------------------------------------------------------

/**
 * Determine whether the user's emotional state is improving, declining, or
 * stable by comparing recent valence values.
 *
 * We split the last 6 emotions into two groups of 3 (recent vs. older) and
 * compare their average valence. A shift of 0.15+ counts as a trend.
 */
function determineEmotionalTrend(
  emotionRows: Array<{ valence: number; dominantEmotion: string }>
): { trend: string; recentEmotions: string[]; current: string } {
  if (emotionRows.length === 0) {
    return { trend: "stable", recentEmotions: [], current: "unknown" };
  }

  const current = emotionRows[0].dominantEmotion;
  const recentEmotions = emotionRows.slice(0, 5).map((e) => e.dominantEmotion);

  if (emotionRows.length < 4) {
    return { trend: "stable", recentEmotions, current };
  }

  // Recent 3 vs older 3
  const recentSlice = emotionRows.slice(0, 3);
  const olderSlice = emotionRows.slice(3, 6);

  if (olderSlice.length === 0) {
    return { trend: "stable", recentEmotions, current };
  }

  const avgRecent =
    recentSlice.reduce((sum, e) => sum + e.valence, 0) / recentSlice.length;
  const avgOlder =
    olderSlice.reduce((sum, e) => sum + e.valence, 0) / olderSlice.length;

  const diff = avgRecent - avgOlder;
  const THRESHOLD = 0.15;

  let trend: string;
  if (diff > THRESHOLD) {
    trend = "improving";
  } else if (diff < -THRESHOLD) {
    trend = "declining";
  } else {
    trend = "stable";
  }

  return { trend, recentEmotions, current };
}

// ---------------------------------------------------------------------------
// Goal check-in logic
// ---------------------------------------------------------------------------

/**
 * Determine whether a goal is due for a check-in based on its
 * `checkInInterval` and `lastCheckedInAt`.
 */
function isGoalDueForCheckIn(goal: {
  checkInInterval: string | null;
  lastCheckedInAt: Date | null;
}): boolean {
  if (!goal.checkInInterval) return false;

  const now = Date.now();
  const lastCheck = goal.lastCheckedInAt
    ? goal.lastCheckedInAt.getTime()
    : 0; // never checked in = always due

  const msPerDay = 86_400_000;
  const intervalMs: Record<string, number> = {
    daily: msPerDay,
    weekly: msPerDay * 7,
    biweekly: msPerDay * 14,
    monthly: msPerDay * 30,
  };

  const requiredGap = intervalMs[goal.checkInInterval] ?? msPerDay * 7;
  return now - lastCheck >= requiredGap;
}

// ---------------------------------------------------------------------------
// Main assembly function
// ---------------------------------------------------------------------------

/**
 * Assemble the full memory context for a user. Called once per chat turn.
 *
 * Fetches everything in parallel to minimize latency:
 * - User profile (from users table + JSONB profile field)
 * - Active entities (people in their life)
 * - Active goals
 * - Recent emotional logs (last 6)
 * - Triggered callbacks (pending, triggerAt <= now)
 * - Conversation summary (for the current conversation)
 * - Active insights
 */
export async function assembleMemoryContext(
  userId: string,
  conversationId?: string
): Promise<MemoryContext> {
  // Fetch everything in parallel
  const [
    userRow,
    entityRows,
    goalRows,
    emotionRows,
    callbackRows,
    summary,
    insightRows,
  ] = await Promise.all([
    getUserProfile(userId),
    getActiveEntities(userId),
    getActiveGoals(userId),
    getRecentEmotions(userId, 6),
    getTriggeredCallbacks(userId),
    conversationId
      ? getConversationSummary(conversationId)
      : Promise.resolve(undefined),
    getActiveInsights(userId),
  ]);

  // --- User Profile ---
  const profileJson = (userRow?.profile ?? {}) as Record<string, unknown>;
  const userProfile: MemoryContext["userProfile"] = {
    name:
      (profileJson.name as string) ??
      userRow?.displayName ??
      undefined,
    lifeState: (profileJson.lifeState as string) ?? undefined,
    socialStyle: (profileJson.socialStyle as string) ?? undefined,
    lifestyle: (profileJson.lifestyle as string) ?? undefined,
    personalityDigest: (profileJson.personalityDigest as string) ?? undefined,
    goals: Array.isArray(profileJson.goals)
      ? (profileJson.goals as string[])
      : undefined,
    communicationStyle:
      userRow?.communicationStyle ?? undefined,
    location: (profileJson.location as string) ?? undefined,
    age: (profileJson.age as string) ?? undefined,
    occupation: (profileJson.occupation as string) ?? undefined,
  };

  // --- Entities ---
  const activeEntities: MemoryContext["activeEntities"] = entityRows.map(
    (e) => ({
      name: e.name,
      type: e.type,
      platform: e.platform,
      status: e.status,
      notes: e.notes ?? "",
      lastMentioned: e.lastMentionedAt.toISOString(),
    })
  );

  // --- Goals ---
  const activeGoals: MemoryContext["activeGoals"] = goalRows.map((g) => ({
    title: g.title,
    category: g.category,
    status: g.status,
    progress: g.progress,
    dueForCheckIn: isGoalDueForCheckIn(g),
  }));

  // --- Emotional State ---
  const emotionalState = determineEmotionalTrend(emotionRows);

  // --- Callbacks ---
  const pendingCallbacks = callbackRows.map((c) => c.content);

  // --- Insights ---
  const insightStrings = insightRows.map(
    (i) => `[${i.type}] ${i.content}`
  );

  return {
    userProfile,
    activeEntities,
    activeGoals,
    emotionalState,
    pendingCallbacks,
    conversationSummary: summary,
    insights: insightStrings,
  };
}

// ---------------------------------------------------------------------------
// Format memory context into readable text for the system prompt
// ---------------------------------------------------------------------------

/**
 * Turn the structured MemoryContext into a human-readable text block that
 * replaces {{USER_CONTEXT}} in the system prompt. Written so that Gemini
 * can read it naturally and reference details in conversation.
 */
export function formatMemoryForPrompt(
  memory: MemoryContext,
  options?: { isFirstMessage?: boolean }
): string {
  const sections: string[] = [];

  // ---- User Profile ----
  const profile = memory.userProfile;
  const profileLines: string[] = [];
  if (profile.name) profileLines.push(`Name: ${profile.name}`);
  if (profile.age) profileLines.push(`Age: ${profile.age}`);
  if (profile.location) profileLines.push(`Location: ${profile.location}`);
  if (profile.occupation) profileLines.push(`Occupation: ${profile.occupation}`);
  if (profile.lifeState) profileLines.push(`Life State: ${profile.lifeState}`);
  if (profile.socialStyle) profileLines.push(`Social Style: ${profile.socialStyle}`);
  if (profile.lifestyle) profileLines.push(`Lifestyle: Prefers ${profile.lifestyle}`);
  if (profile.communicationStyle) {
    const styleDescriptions: Record<string, string> = {
      direct: "Direct -- prefers straight talk, no sugarcoating",
      supportive: "Supportive -- prefers encouragement-first approach",
      balanced: "Balanced -- mix of directness and encouragement",
    };
    profileLines.push(
      `Communication Style: ${styleDescriptions[profile.communicationStyle] ?? profile.communicationStyle}`
    );
  }
  if (profile.personalityDigest) profileLines.push(`Personality: ${profile.personalityDigest}`);

  if (profileLines.length > 0) {
    sections.push(`## User Profile\n${profileLines.join("\n")}`);
  }

  // ---- People in Their Life ----
  if (memory.activeEntities.length > 0) {
    const entityLines = memory.activeEntities.map((e) => {
      const parts: string[] = [`- ${e.name}`];
      const meta: string[] = [];
      if (e.type) meta.push(e.type);
      if (e.platform) meta.push(e.platform);
      if (e.status && e.status !== "unknown") meta.push(e.status);
      if (meta.length > 0) parts[0] += ` (${meta.join(", ")})`;
      if (e.notes) parts[0] += `: ${e.notes}`;
      const lastMentioned = new Date(e.lastMentioned);
      const daysAgo = Math.floor(
        (Date.now() - lastMentioned.getTime()) / 86_400_000
      );
      if (daysAgo > 0) {
        parts[0] += ` [last mentioned ${daysAgo} day${daysAgo === 1 ? "" : "s"} ago]`;
      }
      return parts[0];
    });
    sections.push(
      `## People in Their Life\n${entityLines.join("\n")}`
    );
  }

  // ---- Active Goals ----
  if (memory.activeGoals.length > 0) {
    const goalLines = memory.activeGoals.map((g) => {
      let line = `- [${g.category.toUpperCase()}] ${g.title} (${g.status}`;
      if (g.progress) line += `, ${g.progress}`;
      line += ")";
      if (g.dueForCheckIn) line += " -- DUE FOR CHECK-IN";
      return line;
    });
    sections.push(`## Active Goals\n${goalLines.join("\n")}`);
  }

  // ---- Emotional State ----
  if (memory.emotionalState.current !== "unknown") {
    const emo = memory.emotionalState;
    const emoLines: string[] = [];
    emoLines.push(`Current mood: ${capitalize(emo.current)}`);

    if (emo.trend !== "stable") {
      const trendDescription =
        emo.trend === "improving"
          ? "Improving over recent conversations"
          : "Declining over recent conversations";
      emoLines.push(`Trend: ${trendDescription}`);
    } else {
      emoLines.push(`Trend: Stable`);
    }

    if (emo.recentEmotions.length > 1) {
      emoLines.push(`Recent: ${emo.recentEmotions.join(" -> ")}`);
    }

    sections.push(`## Emotional State\n${emoLines.join("\n")}`);
  }

  // ---- Follow Up On ----
  if (memory.pendingCallbacks.length > 0) {
    const callbackLines = memory.pendingCallbacks.map((c) => `- ${c}`);
    sections.push(`## Follow Up On\n${callbackLines.join("\n")}`);
  }

  // ---- Conversation History ----
  if (memory.conversationSummary) {
    sections.push(
      `## Conversation So Far\n${memory.conversationSummary}`
    );
  }

  // ---- Key Insights ----
  if (memory.insights.length > 0) {
    const insightLines = memory.insights.map((i) => `- ${i}`);
    sections.push(`## Key Insights\n${insightLines.join("\n")}`);
  }

  // ---- First Message Instructions ----
  if (options?.isFirstMessage && memory.userProfile.name) {
    sections.push(
      `## First Message\nThis is the start of a new conversation. The user just completed onboarding. In your first response:\n- Use their name naturally (don't start with "Hey {name}!" — weave it in)\n- Reference ONE specific detail from their profile that shows you were paying attention\n- Ask ONE targeted opening question based on their life state\n- Keep it 2-3 sentences max\n- Don't re-introduce yourself — they already know who you are from onboarding\n- Match your tone to their communication style preference`
    );
  }

  if (sections.length === 0) {
    return "No prior context available. This is a new user.";
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
