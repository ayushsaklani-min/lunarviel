CREATE TYPE "OrderAdmissionSubmissionState" AS ENUM ('ATTEMPTING', 'SUBMITTED', 'UNCERTAIN');

CREATE TABLE "OrderAdmissionSubmission" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "state" "OrderAdmissionSubmissionState" NOT NULL DEFAULT 'ATTEMPTING',
    "publicTxId" TEXT,
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OrderAdmissionSubmission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderAdmissionSubmission_orderId_key"
ON "OrderAdmissionSubmission"("orderId");

CREATE INDEX "OrderAdmissionSubmission_state_createdAt_idx"
ON "OrderAdmissionSubmission"("state", "createdAt");

ALTER TABLE "OrderAdmissionSubmission"
ADD CONSTRAINT "OrderAdmissionSubmission_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "OrderEnvelope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
