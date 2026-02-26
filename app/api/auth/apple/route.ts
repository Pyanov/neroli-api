import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getUserByAppleId, createUser, saveRefreshToken, updateUserLastActive } from "@/lib/db/queries";
import { createAccessToken, createRefreshToken } from "@/lib/auth/jwt";

const appleAuthSchema = z.object({
  identityToken: z.string(),
  displayName: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const body = await request.json();
  const parsed = appleAuthSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const { identityToken, displayName } = parsed.data;

  // TODO: Verify Apple identity token
  // 1. Decode JWT header to get kid
  // 2. Fetch Apple's public keys from https://appleid.apple.com/auth/keys
  // 3. Verify signature and claims (iss, aud, exp)
  // 4. Extract sub (Apple user ID) and email

  // Placeholder — extract sub from token payload
  const tokenParts = identityToken.split(".");
  if (tokenParts.length !== 3) {
    return NextResponse.json({ error: "Invalid identity token" }, { status: 400 });
  }

  let appleUserId: string;
  let email: string | undefined;
  try {
    const payload = JSON.parse(Buffer.from(tokenParts[1], "base64url").toString());
    appleUserId = payload.sub;
    email = payload.email;
  } catch {
    return NextResponse.json({ error: "Failed to decode token" }, { status: 400 });
  }

  let user = await getUserByAppleId(appleUserId);

  if (!user) {
    user = await createUser({ appleUserId, email, displayName });
  } else {
    await updateUserLastActive(user.id);
  }

  const accessToken = await createAccessToken(user.id);
  const refreshToken = await createRefreshToken(user.id);
  await saveRefreshToken(user.id, refreshToken, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

  return NextResponse.json({
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email, displayName: user.displayName },
    isNewUser: !user.lastActiveAt || user.createdAt === user.lastActiveAt,
  });
}
