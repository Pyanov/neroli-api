import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth/middleware";
import {
  updateUserProfile,
  setOnboardingComplete,
  saveOnboardingResponse,
} from "@/lib/db/queries";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

const onboardingSchema = z.object({
  name: z.string().min(1).max(128),
  lifeChapter: z
    .enum([
      "single_looking",
      "heartbreak",
      "leveling_up",
      "relationship",
      "just_vibing",
    ])
    .nullable()
    .optional(),
  socialConfidence: z
    .enum(["wallflower", "slow_warm", "selective", "social_butterfly"])
    .nullable()
    .optional(),
  saturdayNight: z
    .array(z.enum(["active", "social", "creative", "chill", "growth"]))
    .max(2)
    .default([]),
  coachingStyle: z
    .enum(["drill_sergeant", "wise_friend", "hype_man"])
    .nullable()
    .optional(),
  personalityDigest: z.string().max(500).nullable().optional(),
});

// Coaching style → communicationStyle column mapping
const COACHING_TO_COMM_STYLE: Record<string, string> = {
  drill_sergeant: "direct",
  wise_friend: "balanced",
  hype_man: "supportive",
};

// Life chapter → human-readable life state for the profile JSONB
const LIFE_CHAPTER_TO_STATE: Record<string, string> = {
  single_looking: "Single, actively trying to date",
  heartbreak: "Getting over a breakup",
  leveling_up: "Focused on self-improvement",
  relationship: "In a relationship, working on it",
  just_vibing: "Looking for genuine connection and conversation",
};

const SOCIAL_LABELS: Record<string, string> = {
  wallflower: "Highly introverted — prefers solitude or small familiar groups",
  slow_warm: "Slow to warm up — observes before engaging",
  selective: "Selectively social — goes deep one-on-one",
  social_butterfly:
    "Extroverted — naturally initiates and enjoys social settings",
};

const SATURDAY_LABELS: Record<string, string> = {
  active: "fitness/sports",
  social: "social outings with friends",
  creative: "creative projects (music, code, cooking)",
  chill: "relaxation and downtime",
  growth: "reading/self-work",
};

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const parsed = onboardingSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid onboarding data", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const {
      name,
      lifeChapter,
      socialConfidence,
      saturdayNight,
      coachingStyle,
      personalityDigest,
    } = parsed.data;

    // 1. Update display name
    await db
      .update(users)
      .set({ displayName: name.trim() })
      .where(eq(users.id, auth.userId));

    // 2. Update communicationStyle column
    if (coachingStyle) {
      const commStyle = COACHING_TO_COMM_STYLE[coachingStyle] ?? "balanced";
      await db
        .update(users)
        .set({ communicationStyle: commStyle })
        .where(eq(users.id, auth.userId));
    }

    // 3. Build structured profile JSONB
    const profile: Record<string, unknown> = {
      name: name.trim(),
      lifeState: lifeChapter ? LIFE_CHAPTER_TO_STATE[lifeChapter] : undefined,
      socialStyle: socialConfidence
        ? SOCIAL_LABELS[socialConfidence]
        : undefined,
      lifestyle:
        saturdayNight.length > 0
          ? saturdayNight
              .map((s) => SATURDAY_LABELS[s])
              .filter(Boolean)
              .join(" and ")
          : undefined,
      personalityDigest: personalityDigest ?? undefined,
      // Raw values for re-display in profile screens
      onboarding: {
        lifeChapter,
        socialConfidence,
        saturdayNight,
        coachingStyle,
        completedAt: new Date().toISOString(),
      },
    };

    await updateUserProfile(auth.userId, profile);

    // 4. Save individual responses to onboarding_responses table (analytics)
    const responses: Array<{ key: string; value: string }> = [];
    if (lifeChapter)
      responses.push({ key: "life_chapter", value: lifeChapter });
    if (socialConfidence)
      responses.push({ key: "social_confidence", value: socialConfidence });
    if (saturdayNight.length > 0)
      responses.push({
        key: "saturday_night",
        value: saturdayNight.join(","),
      });
    if (coachingStyle)
      responses.push({ key: "coaching_style", value: coachingStyle });
    if (personalityDigest)
      responses.push({
        key: "personality_digest",
        value: personalityDigest,
      });

    await Promise.all(
      responses.map((r) =>
        saveOnboardingResponse(auth.userId, r.key, r.value)
      )
    );

    // 5. Mark onboarding complete
    await setOnboardingComplete(auth.userId);

    console.log(
      `[Onboarding] Saved for user ${auth.userId}: chapter=${lifeChapter}, social=${socialConfidence}, saturday=${saturdayNight.join(",")}, coaching=${coachingStyle}`
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Onboarding API] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
