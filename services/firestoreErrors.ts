// Classifies Firestore "free-tier daily quota exceeded" errors so the sync queue can
// stop gracefully (preserving the persisted queue) rather than treating them as a generic
// failure or — worse — as a Gemini provider rate-limit, which shares the word "quota".
//
// The Firebase JS SDK sets the gRPC-style code 'resource-exhausted' on these. The message
// names the "Free ... read/write units" metric and the firestore.googleapis.com service,
// e.g. "Quota exceeded for quota metric 'Free daily read units per project (free tier
// database)' ... of service 'firestore.googleapis.com'".
export const isFirestoreQuotaError = (e: any): boolean => {
  if (e?.code === 'resource-exhausted') return true;
  const msg = String(e?.message || e || '');
  return (
    /firestore\.googleapis\.com/i.test(msg) ||
    /free\s+(?:daily|tier)[^.]*(?:read|write|quota)/i.test(msg) ||
    /quota metric '\s*free/i.test(msg)
  );
};
