-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('ACTIVE', 'ADMISSION_PAUSED', 'SETTLEMENT_ONLY', 'DISABLED');

-- CreateEnum
CREATE TYPE "EpochState" AS ENUM ('OPEN', 'CLOSED', 'PROVING', 'PENDING_FIRMUP', 'SETTLING', 'FINALIZED', 'RECOMPUTE', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "OrderState" AS ENUM ('PENDING_CHAIN', 'ACCEPTED', 'RESERVED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELLED', 'EXPIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SettlementState" AS ENUM ('CREATED', 'COLLECTING', 'READY', 'SUBMITTED', 'CONFIRMED', 'FAILED_RECOVERABLE', 'FAILED_FINAL');

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "marketKey" TEXT NOT NULL,
    "baseAssetId" TEXT NOT NULL,
    "quoteAssetId" TEXT NOT NULL,
    "marketContractAddress" TEXT NOT NULL,
    "tickSizeAtomic" TEXT NOT NULL,
    "lotSizeAtomic" TEXT NOT NULL,
    "epochDurationSeconds" INTEGER NOT NULL,
    "maxOrdersPerEpoch" INTEGER NOT NULL,
    "minBatchPrivacy" INTEGER NOT NULL,
    "maxPriceCollarBps" INTEGER,
    "feeBps" INTEGER NOT NULL DEFAULT 0,
    "matchingRuleVersion" TEXT NOT NULL,
    "status" "MarketStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Epoch" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "state" "EpochState" NOT NULL DEFAULT 'OPEN',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "scheduledCloseAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "onchainStartIndex" TEXT NOT NULL,
    "onchainEndIndexExclusive" TEXT,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "closeRoot" TEXT,
    "configHash" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "referencePriceHash" TEXT,
    "pendingSolutionCommitment" TEXT,
    "finalSolutionCommitment" TEXT,
    "batchProofTxId" TEXT,
    "settlementTxId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Epoch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderEnvelope" (
    "id" TEXT NOT NULL,
    "clientRequestId" UUID NOT NULL,
    "marketId" TEXT NOT NULL,
    "epochId" TEXT NOT NULL,
    "commitment" TEXT NOT NULL,
    "encryptionKeyId" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "traderTagHash" TEXT NOT NULL,
    "clientSignature" BYTEA NOT NULL,
    "chainAdmissionTxId" TEXT,
    "leafIndex" TEXT,
    "state" "OrderState" NOT NULL DEFAULT 'PENDING_CHAIN',
    "acceptedAt" TIMESTAMP(3),
    "cancelTxId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderEnvelope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatchSolutionRecord" (
    "id" TEXT NOT NULL,
    "epochId" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "solutionCommitment" TEXT NOT NULL,
    "encryptedSolution" BYTEA,
    "proofReference" TEXT,
    "status" TEXT NOT NULL,
    "sanitizedOrderCount" INTEGER NOT NULL,
    "sanitizedMatchedCount" INTEGER,
    "publicVolume" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BatchSolutionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationEnvelope" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "traderTagHash" TEXT NOT NULL,
    "encryptionKeyId" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "firmDeadline" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AllocationEnvelope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementSession" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "state" "SettlementState" NOT NULL DEFAULT 'CREATED',
    "adapterType" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "publicTxId" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementParticipantPayload" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "traderTagHash" TEXT NOT NULL,
    "ciphertextPayload" BYTEA NOT NULL,
    "state" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3),

    CONSTRAINT "SettlementParticipantPayload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatcherKey" (
    "keyId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "privateKeyRef" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "activeFrom" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "MatcherKey_pkey" PRIMARY KEY ("keyId")
);

-- CreateTable
CREATE TABLE "OracleObservation" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "priceTicks" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "signature" BYTEA NOT NULL,
    "payloadHash" TEXT NOT NULL,

    CONSTRAINT "OracleObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responsePayload" BYTEA,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "sanitizedMetadata" JSONB NOT NULL,
    "hashChainPrev" TEXT,
    "hashChainCurrent" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Market_marketKey_key" ON "Market"("marketKey");

-- CreateIndex
CREATE UNIQUE INDEX "Market_marketContractAddress_key" ON "Market"("marketContractAddress");

-- CreateIndex
CREATE INDEX "Epoch_marketId_state_idx" ON "Epoch"("marketId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Epoch_marketId_sequence_key" ON "Epoch"("marketId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "OrderEnvelope_clientRequestId_key" ON "OrderEnvelope"("clientRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderEnvelope_commitment_key" ON "OrderEnvelope"("commitment");

-- CreateIndex
CREATE INDEX "OrderEnvelope_epochId_state_idx" ON "OrderEnvelope"("epochId", "state");

-- CreateIndex
CREATE INDEX "OrderEnvelope_traderTagHash_epochId_idx" ON "OrderEnvelope"("traderTagHash", "epochId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchSolutionRecord_epochId_key" ON "BatchSolutionRecord"("epochId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchSolutionRecord_solutionCommitment_key" ON "BatchSolutionRecord"("solutionCommitment");

-- CreateIndex
CREATE INDEX "AllocationEnvelope_batchId_traderTagHash_idx" ON "AllocationEnvelope"("batchId", "traderTagHash");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementSession_idempotencyKey_key" ON "SettlementSession"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementParticipantPayload_sessionId_traderTagHash_key" ON "SettlementParticipantPayload"("sessionId", "traderTagHash");

-- CreateIndex
CREATE UNIQUE INDEX "OracleObservation_payloadHash_key" ON "OracleObservation"("payloadHash");

-- CreateIndex
CREATE INDEX "OracleObservation_marketId_observedAt_idx" ON "OracleObservation"("marketId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_scope_key_key" ON "IdempotencyRecord"("scope", "key");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "Epoch" ADD CONSTRAINT "Epoch_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEnvelope" ADD CONSTRAINT "OrderEnvelope_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEnvelope" ADD CONSTRAINT "OrderEnvelope_epochId_fkey" FOREIGN KEY ("epochId") REFERENCES "Epoch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchSolutionRecord" ADD CONSTRAINT "BatchSolutionRecord_epochId_fkey" FOREIGN KEY ("epochId") REFERENCES "Epoch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationEnvelope" ADD CONSTRAINT "AllocationEnvelope_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BatchSolutionRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementSession" ADD CONSTRAINT "SettlementSession_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BatchSolutionRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementParticipantPayload" ADD CONSTRAINT "SettlementParticipantPayload_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SettlementSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OracleObservation" ADD CONSTRAINT "OracleObservation_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
