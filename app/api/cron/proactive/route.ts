import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import {
  getAllTriggeredCallbacks,
  getAllGoalsDueForCheckIn,
  getUsersNeedingEmotionalCheckIn,
  getUsersForReEngagement,
  markCallbackDelivered,
  markGoalCheckedIn,
  createProactiveMessage,
  countProactiveMessagesToday,
  expireOldProactiveMessages,
  expireOldCallbacks,
  getActiveInsights,
  getEntities,
  getActiveGoals,
  getRecentEmotions,
  getRecentMessagesForUser,
  getMostRecentConversation,
  getLatestMemorySnapshot,
  getUserById,
} from "@/lib/db/queries";

const MAX_USERS_PER_RUN = 100;
const MAX_PROACTIVE_PER_DAY = 2;

const PROACTIVE_MESSAGE_PROMPT = `You are Neroli, an AI companion for men. You're reaching out proactively to a user — not in response to their message, but because something in their life warrants a check-in.

## Rules

1. Be brief: 1-3 sentences max. This is a text message, not an essay.
2. Reference specific context — use names, events, goals, details you know about them.
3. Sound like a friend texting, not a notification or a bot.
4. Match the user's vibe — if they're casual, be casual. If they're more formal, adjust.
5. Don't be preachy or give unsolicited advice. Just check in.
6. Don't start with "Hey [name]" every time — vary your openers.
7. Don't use emojis excessively — 0-1 per message at most.
8. Never mention that you're an AI or that this is a proactive message.
9. Make it feel like a natural continuation of your relationship.

## Examples of Good Proactive Messages

- "Hey Jake — you had that date with Sarah last night. How'd it go?"
- "You mentioned wanting to hit the gym 3x this week. It's Wednesday and you're at 1 — still planning to go today?"
- "Been thinking about what you said about feeling stuck. Any better today?"
- "Hey, been a few days. Everything good?"
- "How'd the interview go?"
- "Did you end up trying that recipe?"

Respond with ONLY the message text. No quotes, no labels, no explanation.`;

interface TriggerCandidate {
  userId: string;
  triggerType: string;
  context: string;
  callbackId?: string;
  goalId?: string;
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  let generated = 0;
  let skippedRateLimit = 0;
  let skippedNoContext = 0;
  const errors: string[] = [];

  try {
    // Housekeeping: expire old callbacks and proactive messages
    await Promise.all([expireOldCallbacks(), expireOldProactiveMessages()]);

    // Collect all trigger candidates from different sources
    const candidates: TriggerCandidate[] = [];
    const processedUserIds = new Set<string>();

    // 1. Date follow-ups and milestone callbacks
    const triggeredCallbacks = await getAllTriggeredCallbacks(MAX_USERS_PER_RUN);
    for (const cb of triggeredCallbacks) {
      if (processedUserIds.has(cb.userId)) continue;
      candidates.push({
        userId: cb.userId,
        triggerType: cb.triggerType,
        context: `Callback: ${cb.content}`,
        callbackId: cb.id,
      });
      processedUserIds.add(cb.userId);
    }

    // 2. Goal check-ins
    const goalsDue = await getAllGoalsDueForCheckIn(MAX_USERS_PER_RUN);
    for (const goal of goalsDue) {
      if (processedUserIds.has(goal.userId)) continue;
      candidates.push({
        userId: goal.userId,
        triggerType: "goal_check",
        context: `Goal due for check-in: "${goal.title}" (${goal.category}). Progress: ${goal.progress ?? "unknown"}. Check-in interval: ${goal.checkInInterval}.`,
        goalId: goal.id,
      });
      processedUserIds.add(goal.userId);
    }

    // 3. Emotional check-ins
    const emotionalUsers = await getUsersNeedingEmotionalCheckIn(MAX_USERS_PER_RUN);
    for (const entry of emotionalUsers) {
      if (processedUserIds.has(entry.userId)) continue;
      candidates.push({
        userId: entry.userId,
        triggerType: "emotional_check",
        context: `User's last emotional state was ${entry.dominantEmotion} (valence: ${entry.valence}) logged at ${entry.loggedAt.toISOString()}. They haven't messaged since ${entry.lastActiveAt.toISOString()}.`,
      });
      processedUserIds.add(entry.userId);
    }

    // 4. Re-engagement
    const reEngagementUsers = await getUsersForReEngagement(MAX_USERS_PER_RUN);
    for (const { user } of reEngagementUsers) {
      if (processedUserIds.has(user.id)) continue;
      candidates.push({
        userId: user.id,
        triggerType: "re_engagement",
        context: `User hasn't messaged in ${Math.floor((Date.now() - user.lastActiveAt.getTime()) / (1000 * 60 * 60 * 24))} days. They were previously active.`,
      });
      processedUserIds.add(user.id);
    }

    // Process candidates (up to MAX_USERS_PER_RUN)
    const toProcess = candidates.slice(0, MAX_USERS_PER_RUN);

    for (const candidate of toProcess) {
      try {
        // Rate limit: max 2 proactive messages per day per user
        const todayCount = await countProactiveMessagesToday(candidate.userId);
        if (todayCount >= MAX_PROACTIVE_PER_DAY) {
          skippedRateLimit++;
          continue;
        }

        // Assemble memory context for this user
        const memoryContext = await assembleMemoryContext(candidate.userId);
        if (!memoryContext) {
          skippedNoContext++;
          // Still mark callback/goal as handled so we don't retry endlessly
          if (candidate.callbackId) {
            await markCallbackDelivered(candidate.callbackId);
          }
          if (candidate.goalId) {
            await markGoalCheckedIn(candidate.goalId);
          }
          continue;
        }

        // Generate the proactive message via Gemini
        const userPrompt = `## Trigger
${candidate.context}

## Who This User Is
${memoryContext}

Write a brief, natural proactive message for this user based on the trigger above.`;

        const { text } = await generateText({
          model: google("gemini-2.5-flash"),
          system: PROACTIVE_MESSAGE_PROMPT,
          prompt: userPrompt,
        });

        const messageContent = text.trim();
        if (!messageContent || messageContent.length === 0) {
          errors.push(`Empty response for user ${candidate.userId}`);
          continue;
        }

        // Get or reference the user's most recent conversation
        const recentConversation = await getMostRecentConversation(
          candidate.userId
        );

        // Create the proactive message
        await createProactiveMessage({
          userId: candidate.userId,
          conversationId: recentConversation?.id ?? null,
          content: messageContent,
          triggerType: candidate.triggerType,
          callbackId: candidate.callbackId ?? null,
        });

        // Mark the callback/goal as handled
        if (candidate.callbackId) {
          await markCallbackDelivered(candidate.callbackId);
        }
        if (candidate.goalId) {
          await markGoalCheckedIn(candidate.goalId);
        }

        generated++;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        errors.push(`User ${candidate.userId}: ${message}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      {
        success: false,
        error: message,
        generated,
        skippedRateLimit,
        skippedNoContext,
      },
      { status: 500 }
    );
  }

  const durationMs = Date.now() - startTime;

  return NextResponse.json({
    success: true,
    generated,
    skippedRateLimit,
    skippedNoContext,
    errors: errors.length > 0 ? errors : undefined,
    durationMs,
  });
}

/**
 * Assemble a concise memory context string for a user.
 * Used to give Gemini enough info to write a personalized proactive message.
 * Returns null if the user has no meaningful data.
 */
async function assembleMemoryContext(userId: string): Promise<string | null> {
  const [user, snapshot, insightsList, entitiesList, goalsList, emotions, recentMessages] =
    await Promise.all([
      getUserById(userId),
      getLatestMemorySnapshot(userId),
      getActiveInsights(userId),
      getEntities(userId),
      getActiveGoals(userId),
      getRecentEmotions(userId, 5),
      getRecentMessagesForUser(userId, 10),
    ]);

  if (!user) return null;

  // If we have a snapshot, use it as the primary context
  if (snapshot) {
    // Supplement with recent data that may be newer than the snapshot
    const parts = [snapshot.snapshot];

    if (goalsList.length > 0) {
      const goalsText = goalsList
        .map(
          (g) =>
            `- ${g.title} (${g.category}, ${g.status})${g.progress ? ` — ${g.progress}` : ""}`
        )
        .join("\n");
      parts.push(`\nCurrent goals:\n${goalsText}`);
    }

    if (emotions.length > 0) {
      const emotionsText = emotions
        .map(
          (e) =>
            `- ${e.dominantEmotion} (valence: ${e.valence}) at ${e.createdAt.toISOString()}`
        )
        .join("\n");
      parts.push(`\nRecent emotional states:\n${emotionsText}`);
    }

    return parts.join("\n");
  }

  // No snapshot — build context from raw data
  if (insightsList.length === 0 && recentMessages.length === 0) {
    return null; // Not enough context to write a good proactive message
  }

  const parts: string[] = [];

  if (user.displayName) {
    parts.push(`User's name: ${user.displayName}`);
  }
  parts.push(`Communication style: ${user.communicationStyle}`);

  if (insightsList.length > 0) {
    const insightsText = insightsList
      .map((i) => `- [${i.type}] ${i.content}`)
      .join("\n");
    parts.push(`\nInsights:\n${insightsText}`);
  }

  if (entitiesList.length > 0) {
    const entitiesText = entitiesList
      .slice(0, 10) // Limit to most recent 10
      .map(
        (e) =>
          `- ${e.name} (${e.type}${e.platform ? `, ${e.platform}` : ""}, ${e.status})${e.notes ? ` — ${e.notes}` : ""}`
      )
      .join("\n");
    parts.push(`\nPeople mentioned:\n${entitiesText}`);
  }

  if (goalsList.length > 0) {
    const goalsText = goalsList
      .map(
        (g) =>
          `- ${g.title} (${g.category}, ${g.status})${g.progress ? ` — ${g.progress}` : ""}`
      )
      .join("\n");
    parts.push(`\nGoals:\n${goalsText}`);
  }

  if (emotions.length > 0) {
    const emotionsText = emotions
      .map(
        (e) =>
          `- ${e.dominantEmotion} (valence: ${e.valence}) at ${e.createdAt.toISOString()}`
      )
      .join("\n");
    parts.push(`\nRecent emotional states:\n${emotionsText}`);
  }

  if (recentMessages.length > 0) {
    const messagesText = recentMessages
      .reverse() // Chronological order
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n");
    parts.push(`\nRecent conversation:\n${messagesText}`);
  }

  return parts.join("\n");
}
