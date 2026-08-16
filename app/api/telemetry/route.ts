// POST /api/telemetry (BUILD-PLAN Phase 10). Validates the event and
// forwards it to Upstash Redis over its REST API (LPUSH gitsy:telemetry).
// With no Upstash env configured the endpoint is a deliberate no-op that
// still answers 204: local play and CI never depend on analytics.

import { z } from 'zod';

const eventSchema = z.object({
  levelId: z.string().min(1),
  log: z.array(z.string()),
  outcome: z.enum(['complete', 'abandon']),
  durationMs: z.number().nonnegative(),
});

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }
  const parsed = eventSchema.safeParse(json);
  if (!parsed.success) return new Response('bad request', { status: 400 });

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    try {
      // Upstash REST: POST a command array to the base URL.
      await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify([
          'LPUSH',
          'gitsy:telemetry',
          JSON.stringify({ ...parsed.data, at: Date.now() }),
        ]),
      });
    } catch {
      // fire-and-forget: analytics never fail the player
    }
  }
  return new Response(null, { status: 204 });
}
