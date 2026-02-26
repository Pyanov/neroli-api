import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // TODO: Summarize long conversations
  // 1. Find conversations with 50+ messages without recent summary
  // 2. Generate summary with Gemini
  // 3. Update conversation summary field

  return NextResponse.json({ success: true, summarized: 0 });
}
