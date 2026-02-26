import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // TODO: Process recent conversations to extract user insights
  // 1. Find conversations with new messages since last processing
  // 2. Run Gemini to extract insights (preferences, goals, personality traits)
  // 3. Upsert into insights table

  return NextResponse.json({ success: true, processed: 0 });
}
