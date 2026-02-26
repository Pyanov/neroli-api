import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hash } from "bcrypt-ts";
import { getUserByEmail, createUser, saveRefreshToken } from "@/lib/db/queries";
import { createAccessToken, createRefreshToken } from "@/lib/auth/jwt";
import { authRateLimit } from "@/lib/rate-limit";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(100).optional(),
});

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  const { success } = await authRateLimit.limit(ip);
  if (!success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await request.json();
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const { email, password, displayName } = parsed.data;

  const existing = await getUserByEmail(email);
  if (existing) {
    return NextResponse.json({ error: "Email already registered" }, { status: 409 });
  }

  const hashedPassword = await hash(password, 10);
  const user = await createUser({ email, password: hashedPassword, displayName });

  const accessToken = await createAccessToken(user.id);
  const refreshToken = await createRefreshToken(user.id);
  await saveRefreshToken(user.id, refreshToken, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

  return NextResponse.json({ accessToken, refreshToken, user: { id: user.id, email: user.email, displayName: user.displayName } }, { status: 201 });
}
