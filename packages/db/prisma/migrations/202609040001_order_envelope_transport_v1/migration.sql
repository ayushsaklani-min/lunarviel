-- Incremental migration for an existing Lunarveil Prisma baseline.
-- The columns are public/ciphertext envelope transport only. Do not add raw
-- side, price, quantity, min-fill, blinding, opening or owner-secret columns.

ALTER TABLE "OrderEnvelope"
  ADD COLUMN "envelopeVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "envelopeAlgorithm" TEXT NOT NULL DEFAULT 'X25519-HKDF-SHA256-AES-256-GCM',
  ADD COLUMN "ephemeralPublicKey" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "envelopeSalt" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "envelopeNonce" TEXT NOT NULL DEFAULT '';

ALTER TABLE "OrderEnvelope"
  ALTER COLUMN "envelopeAlgorithm" DROP DEFAULT,
  ALTER COLUMN "ephemeralPublicKey" DROP DEFAULT,
  ALTER COLUMN "envelopeSalt" DROP DEFAULT,
  ALTER COLUMN "envelopeNonce" DROP DEFAULT;
