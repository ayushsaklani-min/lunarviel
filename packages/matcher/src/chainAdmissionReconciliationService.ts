import type {
  ChainAdmissionTransitionResultV1,
  DurableChainAdmissionDecisionV1,
} from '@lunarveil/db';

import {
  evaluateChainAdmissionConsensusV1,
  type ChainAdmissionConsensusDecisionV1,
  type ChainAdmissionConsensusInputV1,
} from './chainAdmissionConsensus.js';

export interface ChainAdmissionTransitionRepository {
  apply(orderId: string, decision: DurableChainAdmissionDecisionV1): Promise<ChainAdmissionTransitionResultV1>;
}

export type ChainAdmissionReconciliationServiceResultV1 =
  | {
    readonly decision: Extract<ChainAdmissionConsensusDecisionV1, { action: 'KEEP_PENDING' }>;
    readonly persisted: false;
  }
  | {
    readonly decision: Extract<ChainAdmissionConsensusDecisionV1, { action: 'ACCEPT' | 'PAUSE' }>;
    readonly persisted: true;
    readonly transition: ChainAdmissionTransitionResultV1;
  };

/**
 * Orchestrates already-collected public chain observations. Source collection,
 * finality/reorg policy and scheduling remain outside this deterministic
 * service. It never receives a raw order or private envelope plaintext.
 */
export class ChainAdmissionReconciliationServiceV1 {
  constructor(private readonly repository: ChainAdmissionTransitionRepository) {}

  async reconcile(
    orderId: string,
    consensusInput: ChainAdmissionConsensusInputV1,
  ): Promise<ChainAdmissionReconciliationServiceResultV1> {
    const decision = evaluateChainAdmissionConsensusV1(consensusInput);
    if (decision.action === 'KEEP_PENDING') return { decision, persisted: false };
    const durableDecision: DurableChainAdmissionDecisionV1 = decision.action === 'ACCEPT'
      ? {
        action: 'ACCEPT',
        code: decision.code,
        sourceIds: decision.sourceIds,
        admission: decision.admission,
      }
      : {
        action: 'PAUSE',
        code: decision.code,
        sourceIds: decision.sourceIds,
      };
    return {
      decision,
      persisted: true,
      transition: await this.repository.apply(orderId, durableDecision),
    };
  }
}
