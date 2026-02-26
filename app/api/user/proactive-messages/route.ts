import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth/middleware";
import {
  getPendingProactiveMessages,
  markProactiveMessageDelivered,
  markProactiveMessageRead,
} from "@/lib/db/queries";

/**
 * GET /api/user/proactive-messages
 *
 * Returns pending proactive messages for the authenticated user.
 * Marks them as 'delivered' upon retrieval so they aren't returned again.
 *
 * Response: { messages: Array<{ id, content, createdAt, conversationId, triggerType }> }
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const pending = await getPendingProactiveMessages(auth.userId);

  // Mark all as delivered now that the client has fetched them
  await Promise.all(
    pending.map((msg) => markProactiveMessageDelivered(msg.id))
  );

  return NextResponse.json({
    messages: pending.map((msg) => ({
      id: msg.id,
      content: msg.content,
      createdAt: msg.createdAt,
      conversationId: msg.conversationId,
      triggerType: msg.triggerType,
    })),
  });
}

/**
 * PATCH /api/user/proactive-messages
 *
 * Mark a proactive message as read.
 * Body: { id: string }
 */
export async function PATCH(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  let body: { id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (!body.id || typeof body.id !== "string") {
    return NextResponse.json(
      { error: "Missing or invalid 'id' field" },
      { status: 400 }
    );
  }

  await markProactiveMessageRead(body.id);

  return NextResponse.json({ success: true });
}
