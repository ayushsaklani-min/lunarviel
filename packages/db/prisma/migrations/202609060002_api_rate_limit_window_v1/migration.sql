-- Durable shared fixed-window rate-limit counters for horizontally scaled API processes.
-- Keys are opaque and caller-supplied; no request body, order or identity data is stored.
BEGIN;

CREATE TABLE "ApiRateLimitWindow" (
  "key" TEXT NOT NULL,
  "windowStartedAt" TIMESTAMPTZ(3) NOT NULL,
  "count" INTEGER NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "ApiRateLimitWindow_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "ApiRateLimitWindow_windowStartedAt_idx" ON "ApiRateLimitWindow"("windowStartedAt");

COMMIT;
