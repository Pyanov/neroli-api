import { db } from "./index";
import {
  users,
  conversations,
  messages,
  insights,
  refreshTokens,
  onboardingResponses,
  entities,
  goals,
  emotionalLogs,
  callbacks,
  memorySnapshots,
  proactiveMessages,
} from "./schema";
import { eq, desc, and, gt, lt, lte, or, isNull, ilike, sql, count } from "drizzle-orm";

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

// Cron: Insight Processing

/**
 * Find conversations that have new messages since they were last processed.
 * Returns conversations where updatedAt > lastProcessedAt (or lastProcessedAt is null).
 * Limited to `limit` results to avoid cron timeout.
 */
export async function getConversationsNeedingInsightProcessing(limit: number) {
  return db
    .select()
    .from(conversations)
    .where(
      or(
        isNull(conversations.lastProcessedAt),
        gt(conversations.updatedAt, conversations.lastProcessedAt)
      )
    )
    .orderBy(conversations.updatedAt)
    .limit(limit);
}

/**
 * Mark a conversation as processed for insights.
 */
export async function markConversationProcessed(conversationId: string) {
  await db
    .update(conversations)
    .set({ lastProcessedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

/**
 * Upsert an insight: insert new or update existing by id.
 */
export async function upsertInsight(data: {
  userId: string;
  type: string;
  content: string;
  confidence: number;
}) {
  const [insight] = await db
    .insert(insights)
    .values(data)
    .returning();
  return insight;
}

/**
 * Update an existing insight's content, confidence, and updatedAt.
 */
export async function updateInsight(
  id: string,
  data: { content: string; confidence: number }
) {
  await db
    .update(insights)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(insights.id, id));
}

/**
 * Deactivate an insight by setting active = false.
 */
export async function deactivateInsight(id: string) {
  await db
    .update(insights)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(insights.id, id));
}

// Cron: Conversation Summarization

/**
 * Find conversations with 30+ messages that need summarization.
 * A conversation needs summarization if it has never been summarized,
 * or if it has new messages since the last summary.
 */
export async function getConversationsNeedingSummarization(limit: number) {
  const result = await db
    .select({
      conversation: conversations,
      messageCount: count(messages.id),
    })
    .from(conversations)
    .innerJoin(messages, eq(messages.conversationId, conversations.id))
    .where(
      or(
        isNull(conversations.lastSummarizedAt),
        gt(conversations.updatedAt, conversations.lastSummarizedAt)
      )
    )
    .groupBy(conversations.id)
    .having(sql`count(${messages.id}) >= 30`)
    .orderBy(conversations.updatedAt)
    .limit(limit);

  return result;
}

/**
 * Update conversation summary and mark as summarized.
 */
export async function updateConversationSummary(
  conversationId: string,
  summary: string
) {
  await db
    .update(conversations)
    .set({ summary, lastSummarizedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

// User Profile & Onboarding

/**
 * Update the user's profile JSONB field.
 */
export async function updateUserProfile(
  userId: string,
  profile: Record<string, unknown>
) {
  await db
    .update(users)
    .set({ profile })
    .where(eq(users.id, userId));
}

/**
 * Mark onboarding as complete for a user.
 */
export async function setOnboardingComplete(userId: string) {
  await db
    .update(users)
    .set({ onboardingComplete: true })
    .where(eq(users.id, userId));
}

/**
 * Update a user's subscription status and optional expiration date.
 */
export async function updateSubscriptionStatus(
  userId: string,
  status: string,
  expiresAt?: Date
) {
  await db
    .update(users)
    .set({
      subscriptionStatus: status,
      subscriptionExpiresAt: expiresAt ?? null,
    })
    .where(eq(users.id, userId));
}

/**
 * Save an onboarding response for a user.
 */
export async function saveOnboardingResponse(
  userId: string,
  questionKey: string,
  response: string
) {
  const [row] = await db
    .insert(onboardingResponses)
    .values({ userId, questionKey, response })
    .returning();
  return row;
}

/**
 * Get all onboarding responses for a user, ordered by creation time.
 */
export async function getOnboardingResponses(userId: string) {
  return db
    .select()
    .from(onboardingResponses)
    .where(eq(onboardingResponses.userId, userId))
    .orderBy(onboardingResponses.createdAt);
}

/**
 * Look up a user by their RevenueCat customer ID.
 */
export async function getUserByRevenuecatId(revenuecatId: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.revenuecatId, revenuecatId));
  return user ?? null;
}

// ============================================================
// Entities — People the user mentions
// ============================================================

/**
 * Create a new entity (person the user mentioned).
 */
export async function createEntity(data: {
  userId: string;
  name: string;
  type: string;
  platform?: string | null;
  status?: string;
  notes?: string | null;
  firstMentionedAt?: Date;
  lastMentionedAt?: Date;
  metadata?: Record<string, unknown> | null;
}) {
  const [entity] = await db.insert(entities).values(data).returning();
  return entity;
}

/**
 * Update entity fields.
 */
export async function updateEntity(
  id: string,
  data: Partial<{
    name: string;
    type: string;
    platform: string | null;
    status: string;
    notes: string | null;
    lastMentionedAt: Date;
    metadata: Record<string, unknown> | null;
    active: boolean;
  }>
) {
  const [entity] = await db
    .update(entities)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(entities.id, id))
    .returning();
  return entity;
}

/**
 * Get all active entities for a user.
 */
export async function getEntities(userId: string) {
  return db
    .select()
    .from(entities)
    .where(and(eq(entities.userId, userId), eq(entities.active, true)))
    .orderBy(desc(entities.lastMentionedAt));
}

/**
 * Find entity by name (case insensitive).
 */
export async function getEntityByName(userId: string, name: string) {
  const [entity] = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        ilike(entities.name, name),
        eq(entities.active, true)
      )
    );
  return entity ?? null;
}

/**
 * Soft delete an entity by setting active = false.
 */
export async function deactivateEntity(id: string) {
  await db
    .update(entities)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(entities.id, id));
}

// ============================================================
// Goals — User goals with tracking
// ============================================================

/**
 * Create a new goal.
 */
export async function createGoal(data: {
  userId: string;
  category: string;
  title: string;
  status?: string;
  progress?: string | null;
  targetDate?: Date | null;
  checkInInterval?: string | null;
  source: string;
  confidence?: number;
}) {
  const [goal] = await db.insert(goals).values(data).returning();
  return goal;
}

/**
 * Update goal fields (status, progress, etc.).
 */
export async function updateGoal(
  id: string,
  data: Partial<{
    category: string;
    title: string;
    status: string;
    progress: string | null;
    targetDate: Date | null;
    checkInInterval: string | null;
    lastCheckedInAt: Date | null;
    source: string;
    confidence: number;
  }>
) {
  const [goal] = await db
    .update(goals)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(goals.id, id))
    .returning();
  return goal;
}

/**
 * Get all active goals for a user.
 */
export async function getActiveGoals(userId: string) {
  return db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.status, "active")))
    .orderBy(desc(goals.createdAt));
}

/**
 * Get goals that are due for a check-in.
 * A goal is due when it has a checkInInterval and:
 * - lastCheckedInAt is null (never checked in), OR
 * - lastCheckedInAt + interval < now
 */
export async function getGoalsDueForCheckIn(userId: string) {
  return db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.userId, userId),
        eq(goals.status, "active"),
        sql`${goals.checkInInterval} IS NOT NULL`,
        or(
          isNull(goals.lastCheckedInAt),
          sql`${goals.lastCheckedInAt} + (${goals.checkInInterval} || ' ')::interval < now()`
        )
      )
    )
    .orderBy(goals.createdAt);
}

/**
 * Mark a goal as checked in by updating lastCheckedInAt to now.
 */
export async function markGoalCheckedIn(id: string) {
  await db
    .update(goals)
    .set({ lastCheckedInAt: new Date(), updatedAt: new Date() })
    .where(eq(goals.id, id));
}

// ============================================================
// Emotional Logs — Track emotional state over time
// ============================================================

/**
 * Log an emotional state.
 */
export async function logEmotion(data: {
  userId: string;
  conversationId?: string | null;
  valence: number;
  arousal: number;
  dominantEmotion: string;
  triggers?: string | null;
  notes?: string | null;
}) {
  const [log] = await db.insert(emotionalLogs).values(data).returning();
  return log;
}

/**
 * Get the last N emotional logs for a user.
 */
export async function getRecentEmotions(userId: string, limit: number = 10) {
  return db
    .select()
    .from(emotionalLogs)
    .where(eq(emotionalLogs.userId, userId))
    .orderBy(desc(emotionalLogs.createdAt))
    .limit(limit);
}

/**
 * Get emotional logs over the last N days for trend analysis.
 */
export async function getEmotionalTrend(userId: string, days: number = 7) {
  return db
    .select()
    .from(emotionalLogs)
    .where(
      and(
        eq(emotionalLogs.userId, userId),
        gt(emotionalLogs.createdAt, sql`now() - interval '${sql.raw(String(days))} days'`)
      )
    )
    .orderBy(emotionalLogs.createdAt);
}

// ============================================================
// Callbacks — Things to follow up on later
// ============================================================

/**
 * Create a new callback.
 */
export async function createCallback(data: {
  userId: string;
  content: string;
  triggerType: string;
  triggerAt?: Date | null;
  triggerCondition?: string | null;
  status?: string;
  priority?: string;
  sourceConversationId?: string | null;
}) {
  const [callback] = await db.insert(callbacks).values(data).returning();
  return callback;
}

/**
 * Get all pending callbacks for a user.
 */
export async function getPendingCallbacks(userId: string) {
  return db
    .select()
    .from(callbacks)
    .where(
      and(eq(callbacks.userId, userId), eq(callbacks.status, "pending"))
    )
    .orderBy(callbacks.triggerAt);
}

/**
 * Get callbacks that are ready to be delivered:
 * status = 'pending' AND triggerAt <= now.
 */
export async function getTriggeredCallbacks(userId: string) {
  return db
    .select()
    .from(callbacks)
    .where(
      and(
        eq(callbacks.userId, userId),
        eq(callbacks.status, "pending"),
        lte(callbacks.triggerAt, new Date())
      )
    )
    .orderBy(callbacks.triggerAt);
}

/**
 * Mark a callback as delivered.
 */
export async function markCallbackDelivered(id: string) {
  await db
    .update(callbacks)
    .set({ status: "delivered", updatedAt: new Date() })
    .where(eq(callbacks.id, id));
}

/**
 * Bulk expire callbacks that are past their trigger date by 7+ days.
 */
export async function expireOldCallbacks() {
  await db
    .update(callbacks)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        eq(callbacks.status, "pending"),
        lte(callbacks.triggerAt, sql`now() - interval '7 days'`)
      )
    );
}

// ============================================================
// Memory Snapshots — Periodic summaries of who the user is
// ============================================================

/**
 * Create a new memory snapshot with auto-incrementing version.
 */
export async function createMemorySnapshot(userId: string, snapshot: string) {
  const latest = await getLatestMemorySnapshot(userId);
  const nextVersion = latest ? latest.version + 1 : 1;

  const [row] = await db
    .insert(memorySnapshots)
    .values({ userId, snapshot, version: nextVersion })
    .returning();
  return row;
}

/**
 * Get the most recent memory snapshot for a user.
 */
export async function getLatestMemorySnapshot(userId: string) {
  const [snapshot] = await db
    .select()
    .from(memorySnapshots)
    .where(eq(memorySnapshots.userId, userId))
    .orderBy(desc(memorySnapshots.version))
    .limit(1);
  return snapshot ?? null;
}

// ============================================================
// Proactive Messages — Neroli reaching out to users
// ============================================================

/**
 * Create a new proactive message.
 */
export async function createProactiveMessage(data: {
  userId: string;
  conversationId?: string | null;
  content: string;
  triggerType: string;
  status?: string;
  callbackId?: string | null;
}) {
  const [msg] = await db.insert(proactiveMessages).values(data).returning();
  return msg;
}

/**
 * Get all pending proactive messages for a user.
 */
export async function getPendingProactiveMessages(userId: string) {
  return db
    .select()
    .from(proactiveMessages)
    .where(
      and(
        eq(proactiveMessages.userId, userId),
        eq(proactiveMessages.status, "pending")
      )
    )
    .orderBy(desc(proactiveMessages.createdAt));
}

/**
 * Mark a proactive message as delivered.
 */
export async function markProactiveMessageDelivered(id: string) {
  await db
    .update(proactiveMessages)
    .set({ status: "delivered", deliveredAt: new Date() })
    .where(eq(proactiveMessages.id, id));
}

/**
 * Mark a proactive message as read.
 */
export async function markProactiveMessageRead(id: string) {
  await db
    .update(proactiveMessages)
    .set({ status: "read" })
    .where(eq(proactiveMessages.id, id));
}

/**
 * Count how many proactive messages were sent to a user today.
 * Used for rate limiting (max 2 per day).
 */
export async function countProactiveMessagesToday(userId: string) {
  const [result] = await db
    .select({ count: count(proactiveMessages.id) })
    .from(proactiveMessages)
    .where(
      and(
        eq(proactiveMessages.userId, userId),
        gt(proactiveMessages.createdAt, sql`now() - interval '24 hours'`)
      )
    );
  return result?.count ?? 0;
}

/**
 * Expire old proactive messages that have been pending for 48+ hours.
 */
export async function expireOldProactiveMessages() {
  await db
    .update(proactiveMessages)
    .set({ status: "expired" })
    .where(
      and(
        eq(proactiveMessages.status, "pending"),
        lte(proactiveMessages.createdAt, sql`now() - interval '48 hours'`)
      )
    );
}

// ============================================================
// Proactive Cron — Trigger detection queries
// ============================================================

/**
 * Get all triggered callbacks across all users.
 * Returns callbacks where status = 'pending' AND triggerAt <= now.
 * Limited to avoid cron timeout.
 */
export async function getAllTriggeredCallbacks(limit: number) {
  return db
    .select()
    .from(callbacks)
    .where(
      and(
        eq(callbacks.status, "pending"),
        lte(callbacks.triggerAt, new Date())
      )
    )
    .orderBy(callbacks.triggerAt)
    .limit(limit);
}

/**
 * Get all goals across all users that are due for a check-in.
 */
export async function getAllGoalsDueForCheckIn(limit: number) {
  return db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.status, "active"),
        sql`${goals.checkInInterval} IS NOT NULL`,
        or(
          isNull(goals.lastCheckedInAt),
          sql`${goals.lastCheckedInAt} + (${goals.checkInInterval} || ' ')::interval < now()`
        )
      )
    )
    .orderBy(goals.createdAt)
    .limit(limit);
}

/**
 * Get users who had a very negative emotional state (valence < -0.5) recently
 * and haven't messaged in 24+ hours. Returns user IDs that need emotional check-in.
 */
export async function getUsersNeedingEmotionalCheckIn(limit: number) {
  // Find users whose most recent emotional log has valence < -0.5
  // and who haven't been active in the last 24 hours
  return db
    .select({
      userId: emotionalLogs.userId,
      valence: emotionalLogs.valence,
      dominantEmotion: emotionalLogs.dominantEmotion,
      loggedAt: emotionalLogs.createdAt,
      lastActiveAt: users.lastActiveAt,
    })
    .from(emotionalLogs)
    .innerJoin(users, eq(users.id, emotionalLogs.userId))
    .where(
      and(
        lt(emotionalLogs.valence, sql`-0.5`),
        gt(emotionalLogs.createdAt, sql`now() - interval '48 hours'`),
        lt(users.lastActiveAt, sql`now() - interval '24 hours'`)
      )
    )
    .orderBy(desc(emotionalLogs.createdAt))
    .limit(limit);
}

/**
 * Get users who haven't messaged in 3+ days but were previously active (5+ messages).
 */
export async function getUsersForReEngagement(limit: number) {
  return db
    .select({
      user: users,
      messageCount: count(messages.id),
    })
    .from(users)
    .innerJoin(conversations, eq(conversations.userId, users.id))
    .innerJoin(messages, eq(messages.conversationId, conversations.id))
    .where(
      and(
        lt(users.lastActiveAt, sql`now() - interval '3 days'`),
        gt(users.lastActiveAt, sql`now() - interval '14 days'`), // Don't reach out after 2 weeks
        eq(users.onboardingComplete, true)
      )
    )
    .groupBy(users.id)
    .having(sql`count(${messages.id}) >= 5`)
    .orderBy(desc(users.lastActiveAt))
    .limit(limit);
}

/**
 * Get the most recent conversation for a user.
 */
export async function getMostRecentConversation(userId: string) {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt))
    .limit(1);
  return conv ?? null;
}

/**
 * Get recent messages for a user across all their conversations.
 * Used for proactive message context assembly.
 */
export async function getRecentMessagesForUser(userId: string, limit: number = 20) {
  return db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
      conversationId: messages.conversationId,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(conversations.userId, userId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
}

/**
 * Get all active users (for memory snapshot cron).
 * Active = has messaged in the last 30 days.
 */
export async function getActiveUsers(limit: number) {
  return db
    .select()
    .from(users)
    .where(
      and(
        gt(users.lastActiveAt, sql`now() - interval '30 days'`),
        eq(users.onboardingComplete, true)
      )
    )
    .orderBy(desc(users.lastActiveAt))
    .limit(limit);
}

/**
 * Get conversation summaries for a user.
 */
export async function getConversationSummaries(userId: string) {
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      summary: conversations.summary,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, userId),
        sql`${conversations.summary} IS NOT NULL`
      )
    )
    .orderBy(desc(conversations.updatedAt));
}
