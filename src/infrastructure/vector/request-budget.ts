// Maintainer permits Qdrant-only adjustment; S2.4 regression observed an 11.93s create.
// Per-request ceiling only; callers still enforce their original total deadline.
export const QDRANT_REQUEST_TIMEOUT_MS = 15_000;
