-- Public chain-reconciliation workflow data only. Do not add raw order fields,
-- wallet identities, signatures, ciphertext plaintext, witnesses or balances.

CREATE TYPE "OrderAdmissionReconciliationState" AS ENUM ('PAUSED', 'CONFIRMED');

CREATE TABLE "OrderAdmissionReconciliation" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "state" "OrderAdmissionReconciliationState" NOT NULL,
  "decisionCode" TEXT NOT NULL,
  "decisionHash" TEXT NOT NULL,
  "sourceIds" JSONB NOT NULL,
  "admissionTxId" TEXT,
  "leafIndex" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OrderAdmissionReconciliation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderAdmissionReconciliation_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "OrderEnvelope"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OrderAdmissionReconciliation_orderId_decisionHash_key"
  ON "OrderAdmissionReconciliation"("orderId", "decisionHash");
CREATE INDEX "OrderAdmissionReconciliation_orderId_createdAt_idx"
  ON "OrderAdmissionReconciliation"("orderId", "createdAt");
