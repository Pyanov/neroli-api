import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth/middleware";
import { getConversations, createConversation } from "@/lib/db/queries";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const convs = await getConversations(auth.userId);
  return NextResponse.json(convs);
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => ({}));
  const conv = await createConversation(auth.userId, body.title);
  return NextResponse.json(conv, { status: 201 });
}
