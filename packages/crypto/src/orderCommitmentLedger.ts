import { assertBytes32, bytesToHex, copyBytes } from "./bytes.js";
import { HistoricOrderCommitmentTree } from "./historicOrderTree.js";

export interface OrderAdmissionReceiptV1 {
  readonly epochSequence: bigint;
  readonly index: number;
  readonly commitment: Uint8Array;
  readonly root: bigint;
}

export interface FrozenEpochV1 {
  readonly sequence: bigint;
  readonly startIndex: number;
  readonly endIndexExclusive: number;
  readonly orderCount: number;
  readonly closeRoot: bigint;
}

export interface CancellationReceiptV1 {
  readonly epochSequence: bigint;
  readonly leafIndex: number;
  readonly nullifier: Uint8Array;
}

interface IdempotentRecord<T> {
  readonly fingerprint: string;
  readonly result: T;
}

function requireRequestId(clientRequestId: string): void {
  if (clientRequestId.length < 8 || clientRequestId.length > 128) {
    throw new TypeError("clientRequestId must contain 8 through 128 characters");
  }
}

function cloneAdmission(receipt: OrderAdmissionReceiptV1): OrderAdmissionReceiptV1 {
  return { ...receipt, commitment: copyBytes(receipt.commitment) };
}

function cloneCancellation(receipt: CancellationReceiptV1): CancellationReceiptV1 {
  return { ...receipt, nullifier: copyBytes(receipt.nullifier) };
}

/**
 * One-epoch, four-order M2 state-transition reference. It models admission,
 * close/freeze, cancellation, and idempotency without a DB, clock, or network.
 * A later Compact contract is the integrity source of truth.
 */
export class OrderCommitmentLedgerV1 {
  readonly epochSequence: bigint;
  readonly tree: HistoricOrderCommitmentTree;
  #frozenEpoch: FrozenEpochV1 | undefined;
  #admissions = new Map<string, IdempotentRecord<OrderAdmissionReceiptV1>>();
  #closes = new Map<string, IdempotentRecord<FrozenEpochV1>>();
  #cancellations = new Map<string, IdempotentRecord<CancellationReceiptV1>>();
  #consumedNullifiers = new Set<string>();

  constructor(epochSequence: bigint, depth = 2) {
    if (epochSequence < 0n || epochSequence >= (1n << 64n)) {
      throw new RangeError("epochSequence must fit Uint<64>");
    }
    this.epochSequence = epochSequence;
    this.tree = new HistoricOrderCommitmentTree(depth);
  }

  get frozenEpoch(): FrozenEpochV1 | undefined {
    return this.#frozenEpoch === undefined ? undefined : { ...this.#frozenEpoch };
  }

  submitOrderCommitment(
    clientRequestId: string,
    epochSequence: bigint,
    commitment: Uint8Array,
  ): OrderAdmissionReceiptV1 {
    requireRequestId(clientRequestId);
    assertBytes32(commitment, "commitment");
    const fingerprint = `${epochSequence}:${bytesToHex(commitment)}`;
    const replay = this.#admissions.get(clientRequestId);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) {
        throw new Error("clientRequestId was already used for a different admission");
      }
      return cloneAdmission(replay.result);
    }
    if (this.#frozenEpoch !== undefined) throw new Error("epoch is already closed");
    if (epochSequence !== this.epochSequence) throw new Error("wrong epoch sequence");

    const appended = this.tree.append(commitment);
    const result: OrderAdmissionReceiptV1 = {
      epochSequence,
      index: appended.index,
      commitment: copyBytes(commitment),
      root: appended.root,
    };
    this.#admissions.set(clientRequestId, { fingerprint, result });
    return cloneAdmission(result);
  }

  closeEpoch(clientRequestId: string, epochSequence: bigint): FrozenEpochV1 {
    requireRequestId(clientRequestId);
    const fingerprint = epochSequence.toString();
    const replay = this.#closes.get(clientRequestId);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) {
        throw new Error("clientRequestId was already used for a different epoch close");
      }
      return { ...replay.result };
    }
    if (epochSequence !== this.epochSequence) throw new Error("wrong epoch sequence");

    const result = this.#frozenEpoch ?? {
      sequence: this.epochSequence,
      startIndex: 0,
      endIndexExclusive: this.tree.size,
      orderCount: this.tree.size,
      closeRoot: this.tree.root,
    };
    this.#frozenEpoch = result;
    this.#closes.set(clientRequestId, { fingerprint, result });
    return { ...result };
  }

  cancelAtFrozenRoot(
    clientRequestId: string,
    epochSequence: bigint,
    leafIndex: number,
    commitment: Uint8Array,
    nullifier: Uint8Array,
  ): CancellationReceiptV1 {
    requireRequestId(clientRequestId);
    assertBytes32(commitment, "commitment");
    assertBytes32(nullifier, "nullifier");
    const fingerprint = [
      epochSequence.toString(),
      leafIndex.toString(),
      bytesToHex(commitment),
      bytesToHex(nullifier),
    ].join(":");
    const replay = this.#cancellations.get(clientRequestId);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) {
        throw new Error("clientRequestId was already used for a different cancellation");
      }
      return cloneCancellation(replay.result);
    }

    const epoch = this.#frozenEpoch;
    if (epoch === undefined) throw new Error("epoch is not closed");
    if (epochSequence !== epoch.sequence) throw new Error("wrong epoch sequence");
    if (leafIndex < epoch.startIndex || leafIndex >= epoch.endIndexExclusive) {
      throw new Error("leaf index is outside the frozen epoch range");
    }
    if (!this.tree.verifyInclusion(commitment, leafIndex, epoch.closeRoot)) {
      throw new Error("commitment is not included at the frozen index/root");
    }

    const nullifierHex = bytesToHex(nullifier);
    if (this.#consumedNullifiers.has(nullifierHex)) {
      throw new Error("nullifier is already consumed");
    }
    const result: CancellationReceiptV1 = { epochSequence, leafIndex, nullifier: copyBytes(nullifier) };
    this.#consumedNullifiers.add(nullifierHex);
    this.#cancellations.set(clientRequestId, { fingerprint, result });
    return cloneCancellation(result);
  }

  isNullifierConsumed(nullifier: Uint8Array): boolean {
    assertBytes32(nullifier, "nullifier");
    return this.#consumedNullifiers.has(bytesToHex(nullifier));
  }
}
