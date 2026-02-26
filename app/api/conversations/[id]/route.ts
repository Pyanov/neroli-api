import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth/middleware";
import { getConversation, getMessages, deleteConversation } from "@/lib/db/queries";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const conv = await getConversation(id, auth.userId);
  if (!conv) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const msgs = await getMessages(id);
  return NextResponse.json({ ...conv, messages: msgs });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  await deleteConversation(id, auth.userId);
  return NextResponse.json({ success: true });
}
