-- Public batch outcome for the development-only simulated chain (ADR-0047).
-- The clearing price and total volume are public results of a frequent batch
-- auction; no per-order quantity, price or side is stored.
ALTER TABLE "BatchSolutionRecord" ADD COLUMN "clearingPriceTicks" TEXT;
ALTER TABLE "BatchSolutionRecord" ADD COLUMN "rejectedSolutionCount" INTEGER NOT NULL DEFAULT 0;
