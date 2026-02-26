import { NextRequest, NextResponse } from "next/server";
import { streamText } from "ai";
import { z } from "zod";
import { authenticateRequest } from "@/lib/auth/middleware";
import { companionModel } from "@/lib/ai/providers";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { chatRateLimit } from "@/lib/rate-limit";
import {
  getActiveInsights,
  getMessages,
  createMessage,
  createConversation,
  getConversation,
  updateUserLastActive,
} from "@/lib/db/queries";
import { db } from "@/lib/db";
import { conversations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const chatSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1).max(10000),
});

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { success } = await chatRateLimit.limit(auth.userId);
  if (!success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await request.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const { message } = parsed.data;
  let { conversationId } = parsed.data;

  // Create conversation if not provided
  if (!conversationId) {
    const conv = await createConversation(auth.userId);
    conversationId = conv.id;
  } else {
    const conv = await getConversation(conversationId, auth.userId);
    if (!conv) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }
  }

  // Save user message
  await createMessage({ conversationId, role: "user", content: message });

  // Build context
  const [insightRows, history] = await Promise.all([
    getActiveInsights(auth.userId),
    getMessages(conversationId),
  ]);

  const insightStrings = insightRows.map((i) => `[${i.type}] ${i.content}`);
  const systemPrompt = buildSystemPrompt(insightStrings);

  // Format history for AI SDK
  const aiMessages = history.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  await updateUserLastActive(auth.userId);

  const result = streamText({
    model: companionModel,
    system: systemPrompt,
    messages: aiMessages,
    onFinish: async ({ text }) => {
      // Save assistant message
      await createMessage({ conversationId: conversationId!, role: "assistant", content: text });

      // Update conversation title from first message
      const conv = await getConversation(conversationId!, auth.userId);
      if (conv && !conv.title) {
        const title = message.length > 50 ? message.slice(0, 50) + "..." : message;
        await db
          .update(conversations)
          .set({ title, updatedAt: new Date() })
          .where(eq(conversations.id, conversationId!));
      } else {
        await db
          .update(conversations)
          .set({ updatedAt: new Date() })
          .where(eq(conversations.id, conversationId!));
      }
    },
  });

  return result.toDataStreamResponse({
    headers: {
      "X-Conversation-Id": conversationId,
    },
  });
}
