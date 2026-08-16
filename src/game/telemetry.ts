'use client';

// Telemetry (BUILD-PLAN Phase 10): fire-and-forget level outcomes so the
// curriculum can be tuned from where people actually quit. Sent once per
// level attempt, on completion. Never blocks, never throws: play matters,
// analytics do not.

export interface TelemetryEvent {
  levelId: string;
  /** The persisted command log (the source of truth, section 1). */
  log: string[];
  outcome: 'complete' | 'abandon';
  durationMs: number;
}

export function sendTelemetry(event: TelemetryEvent): void {
  try {
    const body = JSON.stringify(event);
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/api/telemetry', new Blob([body], { type: 'application/json' }));
      return;
    }
    void fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // telemetry must never break play
  }
}
