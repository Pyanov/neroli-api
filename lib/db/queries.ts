import { db } from "./index";
import { users, conversations, messages, insights, refreshTokens } from "./schema";
import { eq, desc, and, gt } from "drizzle-orm";

// Users
export async function getUserByEmail(email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return user ?? null;
}

export async function getUserByAppleId(appleUserId: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.appleUserId, appleUserId));
  return user ?? null;
}

export async function getUserById(id: string) {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user ?? null;
}

export async function createUser(data: {
  email?: string;
  password?: string;
  displayName?: string;
  appleUserId?: string;
}) {
  const [user] = await db.insert(users).values(data).returning();
  return user;
}

export async function updateUserLastActive(id: string) {
  await db
    .update(users)
    .set({ lastActiveAt: new Date() })
    .where(eq(users.id, id));
}

// Conversations
export async function getConversations(userId: string) {
  return db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt));
}

export async function getConversation(id: string, userId: string) {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)));
  return conv ?? null;
}

export async function createConversation(userId: string, title?: string) {
  const [conv] = await db
    .insert(conversations)
    .values({ userId, title })
    .returning();
  return conv;
}

export async function deleteConversation(id: string, userId: string) {
  await db
    .delete(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)));
}

// Messages
export async function getMessages(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt);
}

export async function createMessage(data: {
  conversationId: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}) {
  const [msg] = await db.insert(messages).values(data).returning();
  return msg;
}

// Insights
export async function getActiveInsights(userId: string) {
  return db
    .select()
    .from(insights)
    .where(and(eq(insights.userId, userId), eq(insights.active, true)));
}

export async function deleteInsight(id: string, userId: string) {
  await db
    .delete(insights)
    .where(and(eq(insights.id, id), eq(insights.userId, userId)));
}

// Refresh Tokens
export async function saveRefreshToken(userId: string, token: string, expiresAt: Date) {
  await db.insert(refreshTokens).values({ userId, token, expiresAt });
}

export async function getRefreshToken(token: string) {
  const [rt] = await db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.token, token), gt(refreshTokens.expiresAt, new Date())));
  return rt ?? null;
}

export async function deleteRefreshToken(token: string) {
  await db.delete(refreshTokens).where(eq(refreshTokens.token, token));
}
