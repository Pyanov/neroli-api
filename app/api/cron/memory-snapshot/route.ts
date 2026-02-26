import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import {
  getActiveUsers,
  getActiveInsights,
  getEntities,
  getActiveGoals,
  getRecentEmotions,
  getConversationSummaries,
  getLatestMemorySnapshot,
  createMemorySnapshot,
  getRecentMessagesForUser,
  getUserById,
  getOnboardingResponses,
} from "@/lib/db/queries";

const MAX_USERS_PER_RUN = 50;

const SNAPSHOT_PROMPT = `You are a memory synthesis system for Neroli, an AI companion for men.

Given all the memory data below about a single user, produce a comprehensive narrative snapshot of who this person is. This snapshot will be used by Neroli to quickly understand the user in future conversations.

## What to Include

1. **Demographics & basics**: Name, age, location, job — whatever is known
2. **Primary focus area**: What they're mainly using Neroli for (dating, fitness, career, etc.)
3. **Current situation**: What's happening in their life right now — active dates, job search, relationship issues, etc.
4. **Key people**: Names and relationships — who are the important people in their story
5. **Goals & progress**: What they're working toward and how it's going
6. **Communication style**: How they like to communicate, what kind of feedback they respond to
7. **Emotional trajectory**: How their mood/state has evolved over time
8. **Key interests**: Hobbies, passions, things they care about
9. **Open threads**: Unresolved situations or things to follow up on

## Rules

- Write in third person ("Jake is..." not "You are...")
- Be specific — use names, dates, details
- Keep it under 500 words
- Be factual — don't speculate beyond what the data supports
- Focus on what matters for having a good conversation with this person
- If there's a previous snapshot, update it — don't start from scratch. Preserve important historical context while incorporating new information.
- Do not include any preamble, labels, or formatting headers — just the narrative text.`;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  let snapshotsCreated = 0;
  let skipped = 0;
  const errors: string[] = [];

  try {
    const activeUsers = await getActiveUsers(MAX_USERS_PER_RUN);

    for (const user of activeUsers) {
      try {
        // Fetch all memory data in parallel
        const [
          insightsList,
          entitiesList,
          goalsList,
          emotions,
          conversationSummaryList,
          existingSnapshot,
          recentMessages,
          onboarding,
        ] = await Promise.all([
          getActiveInsights(user.id),
          getEntities(user.id),
          getActiveGoals(user.id),
          getRecentEmotions(user.id, 20),
          getConversationSummaries(user.id),
          getLatestMemorySnapshot(user.id),
          getRecentMessagesForUser(user.id, 30),
          getOnboardingResponses(user.id),
        ]);

        // Skip if there's not enough data to produce a meaningful snapshot
        const hasData =
          insightsList.length > 0 ||
          entitiesList.length > 0 ||
          goalsList.length > 0 ||
          recentMessages.length >= 5;

        if (!hasData) {
          skipped++;
          continue;
        }

        // Skip if the existing snapshot is less than 24 hours old and no new messages
        if (existingSnapshot) {
          const snapshotAge =
            Date.now() - existingSnapshot.createdAt.getTime();
          const twentyFourHours = 24 * 60 * 60 * 1000;
          if (snapshotAge < twentyFourHours) {
            skipped++;
            continue;
          }
        }

        // Build the memory data prompt
        const memoryData = buildMemoryDataPrompt({
          user,
          insights: insightsList,
          entities: entitiesList,
          goals: goalsList,
          emotions,
          conversationSummaries: conversationSummaryList,
          existingSnapshot,
          recentMessages,
          onboarding,
        });

        // Generate the snapshot via Gemini
        const { text } = await generateText({
          model: google("gemini-2.5-flash"),
          system: SNAPSHOT_PROMPT,
          prompt: memoryData,
        });

        const snapshotText = text.trim();
        if (!snapshotText || snapshotText.length < 50) {
          errors.push(
            `Snapshot too short for user ${user.id} (${snapshotText.length} chars)`
          );
          continue;
        }

        await createMemorySnapshot(user.id, snapshotText);
        snapshotsCreated++;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        errors.push(`User ${user.id}: ${message}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      {
        success: false,
        error: message,
        snapshotsCreated,
        skipped,
      },
      { status: 500 }
    );
  }

  const durationMs = Date.now() - startTime;

  return NextResponse.json({
    success: true,
    snapshotsCreated,
    skipped,
    errors: errors.length > 0 ? errors : undefined,
    durationMs,
  });
}

/**
 * Build the full memory data prompt for a user.
 */
function buildMemoryDataPrompt(data: {
  user: {
    id: string;
    displayName: string | null;
    communicationStyle: string;
    createdAt: Date;
    lastActiveAt: Date;
    profile: unknown;
  };
  insights: Array<{ type: string; content: string; confidence: number | null }>;
  entities: Array<{
    name: string;
    type: string;
    platform: string | null;
    status: string;
    notes: string | null;
  }>;
  goals: Array<{
    category: string;
    title: string;
    status: string;
    progress: string | null;
    targetDate: Date | null;
    checkInInterval: string | null;
  }>;
  emotions: Array<{
    valence: number;
    arousal: number;
    dominantEmotion: string;
    triggers: string | null;
    createdAt: Date;
  }>;
  conversationSummaries: Array<{
    title: string | null;
    summary: string | null;
    updatedAt: Date;
  }>;
  existingSnapshot: { snapshot: string; version: number; createdAt: Date } | null;
  recentMessages: Array<{ role: string; content: string; createdAt: Date }>;
  onboarding: Array<{ questionKey: string; response: string }>;
}): string {
  const parts: string[] = [];

  // Previous snapshot
  if (data.existingSnapshot) {
    parts.push(`## Previous Snapshot (v${data.existingSnapshot.version}, ${data.existingSnapshot.createdAt.toISOString()})

${data.existingSnapshot.snapshot}`);
  }

  // Basic info
  parts.push(`## User Basics

- Name: ${data.user.displayName ?? "Unknown"}
- Communication style: ${data.user.communicationStyle}
- Joined: ${data.user.createdAt.toISOString()}
- Last active: ${data.user.lastActiveAt.toISOString()}`);

  // Profile data
  if (data.user.profile && typeof data.user.profile === "object") {
    parts.push(
      `- Profile data: ${JSON.stringify(data.user.profile)}`
    );
  }

  // Onboarding responses
  if (data.onboarding.length > 0) {
    const onboardingText = data.onboarding
      .map((o) => `- ${o.questionKey}: ${o.response}`)
      .join("\n");
    parts.push(`## Onboarding Responses

${onboardingText}`);
  }

  // Insights
  if (data.insights.length > 0) {
    const insightsText = data.insights
      .map(
        (i) => `- [${i.type}] ${i.content} (confidence: ${i.confidence})`
      )
      .join("\n");
    parts.push(`## Insights

${insightsText}`);
  }

  // Entities (people)
  if (data.entities.length > 0) {
    const entitiesText = data.entities
      .map(
        (e) =>
          `- ${e.name} (${e.type}${e.platform ? `, ${e.platform}` : ""}, ${e.status})${e.notes ? ` — ${e.notes}` : ""}`
      )
      .join("\n");
    parts.push(`## People Mentioned

${entitiesText}`);
  }

  // Goals
  if (data.goals.length > 0) {
    const goalsText = data.goals
      .map(
        (g) =>
          `- ${g.title} (${g.category}, ${g.status})${g.progress ? ` — Progress: ${g.progress}` : ""}${g.targetDate ? ` — Target: ${g.targetDate.toISOString()}` : ""}${g.checkInInterval ? ` — Check-in: ${g.checkInInterval}` : ""}`
      )
      .join("\n");
    parts.push(`## Goals

${goalsText}`);
  }

  // Emotional logs
  if (data.emotions.length > 0) {
    const emotionsText = data.emotions
      .map(
        (e) =>
          `- ${e.dominantEmotion} (valence: ${e.valence}, arousal: ${e.arousal}) at ${e.createdAt.toISOString()}${e.triggers ? ` — Trigger: ${e.triggers}` : ""}`
      )
      .join("\n");
    parts.push(`## Recent Emotional States

${emotionsText}`);
  }

  // Conversation summaries
  if (data.conversationSummaries.length > 0) {
    const summariesText = data.conversationSummaries
      .slice(0, 5) // Limit to 5 most recent
      .map(
        (s) =>
          `### ${s.title ?? "Untitled"} (${s.updatedAt.toISOString()})\n${s.summary}`
      )
      .join("\n\n");
    parts.push(`## Conversation Summaries

${summariesText}`);
  }

  // Recent messages (for context not captured in summaries)
  if (data.recentMessages.length > 0) {
    const messagesText = data.recentMessages
      .reverse() // Chronological
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n");
    parts.push(`## Recent Messages

${messagesText}`);
  }

  return parts.join("\n\n");
}
