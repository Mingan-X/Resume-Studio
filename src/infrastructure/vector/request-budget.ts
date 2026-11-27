// 2026-11-27 maintainer-authorized adjustment after observed 5.67–6.46s creates.
// Per-request ceiling only; callers still enforce their original total deadline.
export const QDRANT_REQUEST_TIMEOUT_MS = 10_000;
