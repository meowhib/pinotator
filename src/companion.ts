import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const code = () => randomBytes(24).toString('base64url');
const token = () => randomBytes(32).toString('base64url');
const labelSchema = z.string().max(128).optional();
const modelSchema = z
  .object({
    provider: z.string().max(80),
    id: z.string().max(200),
    name: z.string().max(200).optional(),
  })
  .strict();
const reloadRequestSchema = z.object({ sessionId: z.string().regex(/^[a-f0-9]{32}$/) }).strict();
const reloadCompletionSchema = z
  .object({
    requestId: z.string().regex(/^[a-f0-9]{32}$/),
    outcome: z.enum(['approved', 'declined']),
  })
  .strict();
const statusSchema = z
  .object({
    cwdLabel: labelSchema,
    piVersion: z.string().max(40).optional(),
    model: modelSchema.nullable().optional(),
    busy: z.boolean().optional(),
    activeTools: z.array(z.string().max(100)).max(100).optional(),
    registeredTools: z.array(z.string().max(100)).max(200).optional(),
    commands: z.array(z.string().max(100)).max(200).optional(),
    registeredModels: z.array(modelSchema).max(300).optional(),
  })
  .strict();
interface ReloadState {
  id: string;
  status: 'pending' | 'approved' | 'declined';
  createdAt: number;
  expiresAt: number;
  completedAt?: number;
}
interface CompanionSession {
  id: string;
  token: string;
  status: z.infer<typeof statusSchema>;
  updatedAt: number;
  connectedAt: number;
  reloadRequest: ReloadState | null;
}

const authEqual = (expected: unknown, candidate: unknown): boolean => {
  if (typeof expected !== 'string' || typeof candidate !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** In-memory, paired, metadata-only companion sessions. No session contents or paths are stored. */
export function createCompanionService({
  now = Date.now,
  ttlMs = 60_000,
  pairingTtlMs = 120_000,
} = {}) {
  let pendingPairing: { code: string; expiresAt: number } | null = null;
  const sessions = new Map<string, CompanionSession>();
  const failedClaims = new Map<string, { since: number; attempts: number }>();
  function prune() {
    const current = now();
    for (const [id, session] of sessions)
      if (current - session.updatedAt > ttlMs) sessions.delete(id);
    if (pendingPairing && current > pendingPairing.expiresAt) pendingPairing = null;
    for (const [key, value] of failedClaims)
      if (current - value.since > 300_000) failedClaims.delete(key);
  }
  function recordFailedClaim(remoteAddress: string) {
    const current = now();
    const entry = failedClaims.get(remoteAddress) || { since: current, attempts: 0 };
    if (current - entry.since > 300_000) {
      entry.since = current;
      entry.attempts = 0;
    }
    entry.attempts += 1;
    failedClaims.set(remoteAddress, entry);
    return entry.attempts <= 8;
  }
  function getSession(tokenValue: unknown): CompanionSession | null {
    prune();
    for (const session of sessions.values())
      if (authEqual(session.token, tokenValue)) return session;
    return null;
  }
  return {
    createPairing() {
      prune();
      pendingPairing = { code: code(), expiresAt: now() + pairingTtlMs };
      return {
        code: pendingPairing.code,
        expiresAt: new Date(pendingPairing.expiresAt).toISOString(),
        expiresInSeconds: Math.floor(pairingTtlMs / 1000),
      };
    },
    claim(candidate: unknown, status: unknown, remoteAddress = 'unknown') {
      prune();
      const parsed = statusSchema.safeParse(status);
      if (!parsed.success)
        throw Object.assign(new Error('Invalid companion status.'), {
          code: 'INVALID_COMPANION_STATUS',
          status: 400,
        });
      if (!pendingPairing || !authEqual(pendingPairing.code, candidate)) {
        if (!recordFailedClaim(remoteAddress))
          throw Object.assign(new Error('Pairing temporarily rate limited.'), {
            code: 'PAIR_RATE_LIMITED',
            status: 429,
          });
        throw Object.assign(new Error('Pairing code is invalid or expired.'), {
          code: 'PAIR_CODE_INVALID',
          status: 401,
        });
      }
      if (sessions.size >= 50)
        throw Object.assign(
          new Error('Companion session capacity is full; disconnect an existing process first.'),
          { code: 'COMPANION_CAPACITY', status: 429 },
        );
      pendingPairing = null;
      const session = {
        id: randomBytes(16).toString('hex'),
        token: token(),
        status: parsed.data,
        updatedAt: now(),
        connectedAt: now(),
        reloadRequest: null,
      };
      sessions.set(session.id, session);
      return { sessionId: session.id, token: session.token, ttlSeconds: Math.floor(ttlMs / 1000) };
    },
    update(authToken: unknown, status: unknown) {
      const session = getSession(authToken);
      if (!session)
        throw Object.assign(new Error('Companion session is not paired or has expired.'), {
          code: 'COMPANION_SESSION_EXPIRED',
          status: 401,
        });
      const parsed = statusSchema.safeParse(status);
      if (!parsed.success)
        throw Object.assign(new Error('Invalid companion status.'), {
          code: 'INVALID_COMPANION_STATUS',
          status: 400,
        });
      session.status = parsed.data;
      session.updatedAt = now();
      const action =
        session.reloadRequest?.status === 'pending' && session.reloadRequest.expiresAt > now()
          ? {
              id: session.reloadRequest.id,
              kind: 'reload',
              expiresAt: new Date(session.reloadRequest.expiresAt).toISOString(),
            }
          : null;
      return {
        ok: true,
        updatedAt: new Date(session.updatedAt).toISOString(),
        pendingAction: action,
      };
    },
    close(authToken: unknown) {
      const session = getSession(authToken);
      if (!session) return { ok: true };
      sessions.delete(session.id);
      return { ok: true };
    },
    requestReload(payload: unknown) {
      const { sessionId } = reloadRequestSchema.parse(payload);
      prune();
      const session = sessions.get(sessionId);
      if (!session)
        throw Object.assign(new Error('Companion session is not connected.'), {
          code: 'COMPANION_SESSION_EXPIRED',
          status: 404,
        });
      if (session.status.busy)
        throw Object.assign(
          new Error('Cannot request reload while the Pi process reports an active run.'),
          { code: 'PI_SESSION_BUSY', status: 409 },
        );
      if (session.reloadRequest?.status === 'pending' && session.reloadRequest.expiresAt > now())
        throw Object.assign(new Error('A reload request is already waiting for this Pi process.'), {
          code: 'RELOAD_ALREADY_PENDING',
          status: 409,
        });
      session.reloadRequest = {
        id: randomBytes(16).toString('hex'),
        status: 'pending',
        createdAt: now(),
        expiresAt: now() + 120_000,
      };
      return {
        id: session.reloadRequest.id,
        status: 'pending',
        expiresAt: new Date(session.reloadRequest.expiresAt).toISOString(),
      };
    },
    pending(authToken: unknown) {
      const session = getSession(authToken);
      if (!session)
        throw Object.assign(new Error('Companion session is not paired or has expired.'), {
          code: 'COMPANION_SESSION_EXPIRED',
          status: 401,
        });
      const request = session.reloadRequest;
      if (!request || request.status !== 'pending' || request.expiresAt <= now())
        return { action: null };
      return {
        action: {
          id: request.id,
          kind: 'reload',
          expiresAt: new Date(request.expiresAt).toISOString(),
        },
      };
    },
    completeReload(authToken: unknown, payload: unknown) {
      const { requestId, outcome } = reloadCompletionSchema.parse(payload);
      const session = getSession(authToken);
      if (!session)
        throw Object.assign(new Error('Companion session is not paired or has expired.'), {
          code: 'COMPANION_SESSION_EXPIRED',
          status: 401,
        });
      const request = session.reloadRequest;
      if (
        !request ||
        request.id !== requestId ||
        request.status !== 'pending' ||
        request.expiresAt <= now()
      )
        throw Object.assign(new Error('Reload request is no longer pending.'), {
          code: 'RELOAD_REQUEST_EXPIRED',
          status: 409,
        });
      if (!['approved', 'declined'].includes(outcome))
        throw Object.assign(new Error('Reload outcome must be approved or declined.'), {
          code: 'INVALID_RELOAD_OUTCOME',
          status: 400,
        });
      request.status = outcome;
      request.completedAt = now();
      return { ok: true, status: outcome };
    },
    list() {
      prune();
      return [...sessions.values()].map((session) => ({
        id: session.id,
        status: session.status,
        connectedAt: new Date(session.connectedAt).toISOString(),
        updatedAt: new Date(session.updatedAt).toISOString(),
        expiresInSeconds: Math.max(0, Math.ceil((ttlMs - (now() - session.updatedAt)) / 1000)),
        reloadRequest: session.reloadRequest
          ? {
              status:
                session.reloadRequest.expiresAt <= now() &&
                session.reloadRequest.status === 'pending'
                  ? 'expired'
                  : session.reloadRequest.status,
              createdAt: new Date(session.reloadRequest.createdAt).toISOString(),
              expiresAt: new Date(session.reloadRequest.expiresAt).toISOString(),
            }
          : null,
      }));
    },
  };
}
