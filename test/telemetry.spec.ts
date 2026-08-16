// The telemetry route (Phase 10): validates the event, forwards to Upstash
// when env is configured, and is a silent 204 no-op when it is not.

import { describe, expect, it } from 'vitest';
import { POST } from '../app/api/telemetry/route';

const post = (body: unknown): Promise<Response> =>
  POST(
    new Request('http://localhost/api/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('POST /api/telemetry', () => {
  it('accepts a valid event with no Upstash env (204 no-op)', async () => {
    const res = await post({
      levelId: 'act1-01-first-commit',
      log: ['git status', 'git add a.txt'],
      outcome: 'complete',
      durationMs: 42_000,
    });
    expect(res.status).toBe(204);
  });

  it('rejects malformed events with 400', async () => {
    expect((await post({ levelId: 'x' })).status).toBe(400);
    expect(
      (await post({ levelId: 'x', log: 'not-an-array', outcome: 'complete', durationMs: 1 }))
        .status,
    ).toBe(400);
    expect(
      (await post({ levelId: 'x', log: [], outcome: 'won it', durationMs: 1 })).status,
    ).toBe(400);
    expect(
      (await post({ levelId: 'x', log: [], outcome: 'complete', durationMs: -5 })).status,
    ).toBe(400);
  });

  it('rejects non-JSON bodies with 400', async () => {
    const res = await POST(
      new Request('http://localhost/api/telemetry', { method: 'POST', body: 'not json' }),
    );
    expect(res.status).toBe(400);
  });
});
