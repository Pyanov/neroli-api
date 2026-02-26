import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import {
  getConversationsNeedingSummarization,
  getMessages,
  updateConversationSummary,
} from "@/lib/db/queries";

const MAX_CONVERSATIONS_PER_RUN = 30;

const SUMMARIZATION_PROMPT = `You are a conversation summarizer for Neroli, an AI companion for men.

Given a conversation between a user and Neroli, produce a concise summary that captures:

1. **Main topics discussed** — what the user came to talk about
2. **Key decisions or advice given** — any actionable guidance Neroli provided
3. **Emotional arc** — how the user's mood/energy shifted during the conversation
4. **Open threads** — unresolved topics or things the user said they'd follow up on
5. **Important details** — names, dates, specific plans mentioned

## Rules

- Keep the summary under 300 words.
- Write in third person ("The user discussed..." not "You discussed...").
- Focus on what matters for future conversations — what should Neroli remember?
- Be factual and specific, not vague.
- Do not include any preamble or labels — just the summary text.`;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  let summarized = 0;
  const errors: string[] = [];

  try {
    const conversationsToSummarize =
      await getConversationsNeedingSummarization(MAX_CONVERSATIONS_PER_RUN);

    for (const { conversation } of conversationsToSummarize) {
      try {
        const messageRows = await getMessages(conversation.id);

        if (messageRows.length < 30) {
          // Safety check — the query should already filter, but just in case
          continue;
        }

        // Format messages for the prompt
        const formattedMessages = messageRows
          .map((m) => `[${m.role}]: ${m.content}`)
          .join("\n\n");

        // Include existing summary if there is one (for incremental updates)
        const existingSummaryBlock = conversation.summary
          ? `\n\n## Previous Summary\n\n${conversation.summary}\n\nUpdate this summary to incorporate the full conversation below. Keep it concise.`
          : "";

        const userPrompt = `${existingSummaryBlock}\n\n## Conversation (${messageRows.length} messages)\n\n${formattedMessages}`;

        const { text } = await generateText({
          model: google("gemini-2.5-flash"),
          system: SUMMARIZATION_PROMPT,
          prompt: userPrompt,
        });

        const summary = text.trim();
        if (summary.length > 0) {
          await updateConversationSummary(conversation.id, summary);
          summarized++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        errors.push(`Conversation ${conversation.id}: ${message}`);
        // Continue processing other conversations
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message, summarized },
      { status: 500 }
    );
  }

  const durationMs = Date.now() - startTime;

  return NextResponse.json({
    success: true,
    summarized,
    errors: errors.length > 0 ? errors : undefined,
    durationMs,
  });
}
