import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { compare } from "bcrypt-ts";
import { getUserByEmail, saveRefreshToken, updateUserLastActive } from "@/lib/db/queries";
import { createAccessToken, createRefreshToken } from "@/lib/auth/jwt";
import { authRateLimit } from "@/lib/rate-limit";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  const { success } = await authRateLimit.limit(ip);
  if (!success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await request.json();
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const { email, password } = parsed.data;

  const user = await getUserByEmail(email);
  if (!user || !user.password) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const valid = await compare(password, user.password);
  if (!valid) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  await updateUserLastActive(user.id);

  const accessToken = await createAccessToken(user.id);
  const refreshToken = await createRefreshToken(user.id);
  await saveRefreshToken(user.id, refreshToken, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

  return NextResponse.json({ accessToken, refreshToken, user: { id: user.id, email: user.email, displayName: user.displayName } });
}
