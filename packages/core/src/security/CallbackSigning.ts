import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../util/hash.js";

/**
 * The signed portion of a delegated-agent callback. The `result` is the
 * structured output the delegated agent produced. `nonce` + `timestamp` guard
 * against replay.
 */
export interface CallbackPayload {
  runId: string;
  channelId: string;
  nonce: string;
  /** ISO-8601 timestamp of when the callback was produced. */
  timestamp: string;
  result: unknown;
}

export interface VerifyOptions {
  /** Per-channel signing secret (hex). */
  secret: string;
  payload: CallbackPayload;
  /** HMAC-SHA256 hex signature presented by the caller. */
  signature: string | null | undefined;
  /** Replay window in ms (default 1 hour). */
  windowMs?: number;
  /** Reference "now" in ms (defaults to Date.now()); injectable for tests. */
  nowMs?: number;
  /**
   * Returns true if this (runId, channelId, nonce) was already seen. When
   * provided and it returns true, verification fails as a replay. Callers
   * implement the store; an in-memory Set is sufficient for a single instance.
   */
  isNonceSeen?: (key: string) => boolean;
}

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: "missing" | "invalid" | "expired" | "replayed" };

const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Generate a per-channel signing secret (hex). */
export function generateChannelSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Generate a per-callback nonce (hex). */
export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Stable key identifying a single callback for replay tracking. */
export function nonceKey(payload: Pick<CallbackPayload, "runId" | "channelId" | "nonce">): string {
  return `${payload.runId}:${payload.channelId}:${payload.nonce}`;
}

/**
 * Canonicalize the payload for signing: sorted-key JSON over the exact signed
 * fields (never additional transport fields), so the signer and verifier agree
 * byte-for-byte regardless of property order.
 */
export function canonicalizeCallback(payload: CallbackPayload): string {
  return canonicalJson({
    runId: payload.runId,
    channelId: payload.channelId,
    nonce: payload.nonce,
    timestamp: payload.timestamp,
    result: payload.result,
  });
}

/** Compute the HMAC-SHA256 (hex) signature of a callback payload. */
export function signCallback(secret: string, payload: CallbackPayload): string {
  return createHmac("sha256", secret).update(canonicalizeCallback(payload), "utf8").digest("hex");
}

/**
 * Verify a callback: signature present, HMAC matches (constant-time),
 * timestamp within the window, and nonce not replayed.
 */
export function verifyCallback(options: VerifyOptions): VerifyResult {
  const { secret, payload, signature } = options;
  if (!signature) return { valid: false, reason: "missing" };

  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const nowMs = options.nowMs ?? Date.now();

  const expected = signCallback(secret, payload);
  if (!constantTimeEqualHex(expected, signature)) {
    return { valid: false, reason: "invalid" };
  }

  const ts = Date.parse(payload.timestamp);
  if (Number.isNaN(ts) || Math.abs(nowMs - ts) > windowMs) {
    return { valid: false, reason: "expired" };
  }

  if (options.isNonceSeen?.(nonceKey(payload))) {
    return { valid: false, reason: "replayed" };
  }

  return { valid: true };
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}
