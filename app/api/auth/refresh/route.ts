import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyRefreshToken, createAccessToken, createRefreshToken } from "@/lib/auth/jwt";
import { getRefreshToken, deleteRefreshToken, saveRefreshToken } from "@/lib/db/queries";

const refreshSchema = z.object({
  refreshToken: z.string(),
});

export async function POST(request: NextRequest) {
  const body = await request.json();
  const parsed = refreshSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const { refreshToken: oldToken } = parsed.data;

  // Verify JWT signature
  const payload = await verifyRefreshToken(oldToken);
  if (!payload) {
    return NextResponse.json({ error: "Invalid refresh token" }, { status: 401 });
  }

  // Check token exists in DB (not revoked)
  const stored = await getRefreshToken(oldToken);
  if (!stored) {
    return NextResponse.json({ error: "Refresh token revoked or expired" }, { status: 401 });
  }

  // Rotate: delete old, create new
  await deleteRefreshToken(oldToken);
  const accessToken = await createAccessToken(payload.userId);
  const refreshToken = await createRefreshToken(payload.userId);
  await saveRefreshToken(payload.userId, refreshToken, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

  return NextResponse.json({ accessToken, refreshToken });
}
