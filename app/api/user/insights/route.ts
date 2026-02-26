import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth/middleware";
import { getActiveInsights } from "@/lib/db/queries";

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const userInsights = await getActiveInsights(auth.userId);
  return NextResponse.json(userInsights);
}
