import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  real,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).unique(),
  password: varchar("password", { length: 255 }),
  displayName: varchar("display_name", { length: 100 }),
  avatarUrl: text("avatar_url"),
  appleUserId: varchar("apple_user_id", { length: 255 }).unique(),
  onboardingComplete: boolean("onboarding_complete").default(false).notNull(),
  profile: jsonb("profile"), // structured user profile from onboarding + ongoing extraction
  subscriptionStatus: varchar("subscription_status", { length: 20 })
    .default("free")
    .notNull(), // 'free' | 'trial' | 'active' | 'expired' | 'cancelled'
  subscriptionExpiresAt: timestamp("subscription_expires_at"),
  revenuecatId: varchar("revenuecat_id", { length: 255 }).unique(),
  communicationStyle: varchar("communication_style", { length: 20 })
    .default("balanced")
    .notNull(), // 'direct' | 'supportive' | 'balanced'
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastActiveAt: timestamp("last_active_at").defaultNow().notNull(),
});

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  title: varchar("title", { length: 255 }),
  summary: text("summary"),
  lastProcessedAt: timestamp("last_processed_at"),
  lastSummarizedAt: timestamp("last_summarized_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .references(() => conversations.id, { onDelete: "cascade" })
    .notNull(),
  role: varchar("role", { length: 20 }).notNull(), // 'user' | 'assistant'
  content: text("content").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Valid types: 'preference' | 'goal' | 'context' | 'personality' | 'life_state' | 'relationship' | 'person' | 'milestone'
export const insights = pgTable("insights", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  type: varchar("type", { length: 50 }).notNull(), // 'preference' | 'goal' | 'context' | 'personality' | 'life_state' | 'relationship' | 'person' | 'milestone'
  content: text("content").notNull(),
  confidence: real("confidence").default(0.5),
  active: boolean("active").default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const onboardingResponses = pgTable("onboarding_responses", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  questionKey: varchar("question_key", { length: 100 }).notNull(), // e.g. 'primary_need', 'dating_status', 'communication_style'
  response: text("response").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  token: varchar("token", { length: 500 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// People the user mentions: matches, dates, exes, friends, family, coworkers, therapists, etc.
export const entities = pgTable("entities", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  type: varchar("type", { length: 50 }).notNull(), // 'match' | 'date' | 'partner' | 'ex' | 'friend' | 'family' | 'coworker' | 'therapist' | 'other'
  platform: varchar("platform", { length: 50 }), // 'hinge' | 'tinder' | 'bumble' | 'irl' | null
  status: varchar("status", { length: 50 }).default("unknown").notNull(), // 'active' | 'inactive' | 'ended' | 'unknown'
  notes: text("notes"),
  firstMentionedAt: timestamp("first_mentioned_at").defaultNow().notNull(),
  lastMentionedAt: timestamp("last_mentioned_at").defaultNow().notNull(),
  metadata: jsonb("metadata"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// User goals with tracking
export const goals = pgTable("goals", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  category: varchar("category", { length: 50 }).notNull(), // 'dating' | 'fitness' | 'career' | 'social' | 'style' | 'health' | 'personal'
  title: text("title").notNull(),
  status: varchar("status", { length: 30 }).default("active").notNull(), // 'active' | 'completed' | 'paused' | 'abandoned'
  progress: text("progress"),
  targetDate: timestamp("target_date"),
  checkInInterval: varchar("check_in_interval", { length: 20 }), // 'daily' | 'weekly' | 'biweekly' | 'monthly' | null
  lastCheckedInAt: timestamp("last_checked_in_at"),
  source: varchar("source", { length: 30 }).notNull(), // 'explicit' | 'inferred' | 'suggested'
  confidence: real("confidence").default(0.8).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Track emotional state over time
export const emotionalLogs = pgTable("emotional_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  conversationId: uuid("conversation_id").references(() => conversations.id, {
    onDelete: "cascade",
  }),
  valence: real("valence").notNull(), // -1.0 (very negative) to 1.0 (very positive)
  arousal: real("arousal").notNull(), // 0.0 (calm) to 1.0 (activated/excited)
  dominantEmotion: varchar("dominant_emotion", { length: 50 }).notNull(), // 'happy' | 'sad' | 'anxious' | 'angry' | 'hopeful' | 'frustrated' | 'excited' | 'neutral' | 'heartbroken' | 'confident' | 'lonely' | 'grateful'
  triggers: text("triggers"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Things to follow up on later
export const callbacks = pgTable("callbacks", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  content: text("content").notNull(),
  triggerType: varchar("trigger_type", { length: 30 }).notNull(), // 'date_event' | 'time_based' | 'goal_check' | 'emotional_check' | 'milestone'
  triggerAt: timestamp("trigger_at"),
  triggerCondition: text("trigger_condition"),
  status: varchar("status", { length: 20 }).default("pending").notNull(), // 'pending' | 'delivered' | 'expired' | 'cancelled'
  priority: varchar("priority", { length: 10 }).default("medium").notNull(), // 'high' | 'medium' | 'low'
  sourceConversationId: uuid("source_conversation_id").references(
    () => conversations.id
  ),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Proactive messages from Neroli to users
export const proactiveMessages = pgTable("proactive_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  conversationId: uuid("conversation_id").references(() => conversations.id),
  content: text("content").notNull(),
  triggerType: varchar("trigger_type", { length: 30 }).notNull(), // 'date_event' | 'goal_check' | 'emotional_check' | 're_engagement' | 'milestone'
  status: varchar("status", { length: 20 }).default("pending").notNull(), // 'pending' | 'delivered' | 'read' | 'expired'
  callbackId: uuid("callback_id").references(() => callbacks.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deliveredAt: timestamp("delivered_at"),
});

// Periodic summaries of who the user is
export const memorySnapshots = pgTable("memory_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  snapshot: text("snapshot").notNull(),
  version: integer("version").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
