import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { streamText } from "ai";
import { z } from "zod";
import { authenticateRequest } from "@/lib/auth/middleware";
import { companionModel } from "@/lib/ai/providers";
import { buildSystemPromptWithMemory } from "@/lib/ai/prompts";
import { assembleMemoryContext, formatMemoryForPrompt } from "@/lib/ai/memory";
import { chatRateLimit } from "@/lib/rate-limit";
import {
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

  // Build context — assemble full memory and message history in parallel
  const [memory, history] = await Promise.all([
    assembleMemoryContext(auth.userId, conversationId),
    getMessages(conversationId),
  ]);

  // Detect first message: history has only the user message we just saved
  const isFirstMessage = history.length <= 1;
  const formattedMemory = formatMemoryForPrompt(memory, { isFirstMessage });
  const systemPrompt = buildSystemPromptWithMemory(formattedMemory);

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
  });

  // Use Next.js after() to persist the assistant message after response streams
  // This keeps the serverless function alive to complete DB writes
  const convId = conversationId;
  after(async () => {
    const fullText = await result.text;
    if (fullText) {
      await createMessage({ conversationId: convId, role: "assistant", content: fullText });
    }

    // Update conversation title from first user message
    const conv = await getConversation(convId, auth.userId);
    if (conv && !conv.title) {
      const title = message.length > 50 ? message.slice(0, 50) + "..." : message;
      await db
        .update(conversations)
        .set({ title, updatedAt: new Date() })
        .where(eq(conversations.id, convId));
    } else if (conv) {
      await db
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, convId));
    }
  });

  return result.toTextStreamResponse({
    headers: {
      "X-Conversation-Id": conversationId,
    },
  });
}
