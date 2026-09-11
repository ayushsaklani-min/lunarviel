import {
  CompactTypeBytes,
  CompactTypeField,
  StateBoundedMerkleTree,
  type AlignedValue,
} from "@midnight-ntwrk/compact-runtime";

import { assertBytes32, copyBytes } from "./bytes.js";

const bytes32Type = new CompactTypeBytes(32);

function alignedCommitment(commitment: Uint8Array): AlignedValue {
  return {
    value: bytes32Type.toValue(commitment),
    alignment: bytes32Type.alignment(),
  };
}

function rootField(tree: StateBoundedMerkleTree): bigint {
  const root = tree.root();
  if (root === undefined) {
    throw new Error("Midnight runtime returned an invalid Merkle root");
  }
  return CompactTypeField.fromValue([...root.value]);
}

export interface OrderTreeAppendResult {
  readonly index: number;
  readonly root: bigint;
}

interface TreeSnapshot {
  readonly tree: StateBoundedMerkleTree;
  readonly leaves: readonly Uint8Array[];
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Deterministic off-chain mirror for the M2 bounded HistoricMerkleTree spike.
 * It uses the pinned Midnight on-chain runtime's Merkle implementation; the
 * Compact ledger remains authoritative once the contract circuit is compiled.
 */
export class HistoricOrderCommitmentTree {
  readonly depth: number;
  readonly capacity: number;
  #tree: StateBoundedMerkleTree;
  #leaves: Uint8Array[] = [];
  #history = new Map<bigint, TreeSnapshot>();

  constructor(depth = 2) {
    if (!Number.isInteger(depth) || depth < 2 || depth > 32) {
      throw new RangeError("depth must be an integer from 2 through 32");
    }
    if (depth > 30) {
      throw new RangeError("the TypeScript M2 mirror supports depth at most 30");
    }
    this.depth = depth;
    this.capacity = 2 ** depth;
    this.#tree = new StateBoundedMerkleTree(depth);
    this.#rememberRoot();
  }

  get size(): number {
    return this.#leaves.length;
  }

  get root(): bigint {
    return rootField(this.#tree);
  }

  leaf(index: number): Uint8Array | undefined {
    const leaf = this.#leaves[index];
    return leaf === undefined ? undefined : copyBytes(leaf);
  }

  append(commitment: Uint8Array): OrderTreeAppendResult {
    assertBytes32(commitment, "commitment");
    if (this.size >= this.capacity) throw new RangeError("order commitment tree is full");

    const index = this.size;
    this.#tree = this.#tree.update(BigInt(index), alignedCommitment(commitment)).rehash();
    this.#leaves.push(copyBytes(commitment));
    const root = this.#rememberRoot();
    return { index, root };
  }

  isKnownRoot(root: bigint): boolean {
    return this.#history.has(root);
  }

  verifyInclusion(commitment: Uint8Array, index: number, root: bigint): boolean {
    assertBytes32(commitment, "commitment");
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.capacity) return false;

    const snapshot = this.#history.get(root);
    if (snapshot === undefined) return false;
    const leafAtIndex = snapshot.leaves[index];
    if (leafAtIndex === undefined || !bytesEqual(leafAtIndex, commitment)) return false;
    return snapshot.tree.findPathForLeaf(alignedCommitment(commitment)) !== undefined;
  }

  #rememberRoot(): bigint {
    const root = rootField(this.#tree);
    this.#history.set(root, {
      tree: this.#tree,
      leaves: this.#leaves.map(copyBytes),
    });
    return root;
  }
}
