// Representative inputs: one per content mode. Kept small and synthetic (no real user data).

export const PERSONA = `Name: Ada (sample persona)
Role: Backend engineer and part-time maker, based in Lagos.
Expertise: TypeScript, distributed systems, Postgres, developer tooling.
Interests: open source, teaching beginners, Afrobeats, football.
Voice: warm, plain English, light humour, no hype, no emojis except occasionally one.
Audience: junior-to-mid developers and non-technical founders.
Avoid: politics, religion, financial advice, exaggerated claims.
Why they haven't posted: "I never know what's worth sharing and I hate sounding like I'm bragging."`;

export interface Fixture {
  id: string;
  mode: "build_in_public" | "teach" | "expert_take" | "smile";
  context: string;
}

export const FIXTURES: Fixture[] = [
  {
    id: "release-notes",
    mode: "build_in_public",
    context: `Repo: ada/queue-lite (412 stars)
Release v1.4.0 merged today.
- Added retry with exponential backoff and jitter
- Dead-letter queue for jobs that fail 5 times
- 38% lower p99 latency after switching to batched acks
- First external contributor PR merged (@kemi-dev fixed a race condition)`,
  },
  {
    id: "blog-excerpt",
    mode: "teach",
    context: `From Ada's blog draft: "Most N+1 query bugs hide in serializers, not controllers.
When you render a list of 50 orders and each order lazily loads its customer, you just ran 51 queries.
Fix: eager-load with a join or a batched IN query, and add a test that asserts the query count."`,
  },
  {
    id: "opinion-note",
    mode: "expert_take",
    context: `Voice note transcript: "Everyone says use microservices from day one. For a team of three
that's a trap. Start with a modular monolith, draw module boundaries you could split later, and only
split when a module has a different scaling or deploy need. I've seen two startups burn a year on this."`,
  },
  {
    id: "casual-moment",
    mode: "smile",
    context: `Ada: "My code worked on the first try today and I spent 20 minutes looking for the bug
because I didn't trust it. Also NEPA took light exactly when the deploy finished."`,
  },
];

export const PLATFORMS = [
  "linkedin",
  "x",
  "instagram_caption",
  "facebook",
  "threads",
  "bluesky",
  "tiktok_script",
  "youtube_short_script",
] as const;

export type Platform = (typeof PLATFORMS)[number];
