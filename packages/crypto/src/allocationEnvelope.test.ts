import { describe, expect, it } from 'vitest';

import {
  allocationRecipientPublicKeyV1,
  generateAllocationRecipientDecryptionKeyV1,
  sealAllocationEnvelopeV1,
  withOpenedAllocationEnvelopeV1,
} from './allocationEnvelope.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function header() {
  return {
    allocationId: '8d246316-9c6b-4c9f-a7f5-b5d4ae874903',
    batchId: 'batch-7',
    traderTagHash: '22'.repeat(32),
  };
}

describe('AllocationEnvelopeV1', () => {
  it('round-trips private allocation data only through the recipient and clears plaintext', async () => {
    const recipient = await generateAllocationRecipientDecryptionKeyV1('recipient-key-1');
    const privateAllocation = encoder.encode('{"firmDeadline":"private","quantityLots":"7"}');
    const envelope = await sealAllocationEnvelopeV1({
      header: header(), recipientKey: allocationRecipientPublicKeyV1(recipient), plaintext: privateAllocation,
    });
    let consumed: Uint8Array | undefined;
    const decoded = await withOpenedAllocationEnvelopeV1(envelope, recipient, plaintext => {
      consumed = plaintext;
      return decoder.decode(plaintext);
    });

    expect(decoded).toContain('quantityLots');
    expect(JSON.stringify(envelope)).not.toContain('quantityLots');
    expect([...consumed ?? []].every(value => value === 0)).toBe(true);
  });

  it('rejects tampered authenticated routing metadata and another recipient key', async () => {
    const recipient = await generateAllocationRecipientDecryptionKeyV1('recipient-key-1');
    const otherRecipient = await generateAllocationRecipientDecryptionKeyV1('recipient-key-2');
    const envelope = await sealAllocationEnvelopeV1({
      header: header(), recipientKey: allocationRecipientPublicKeyV1(recipient), plaintext: encoder.encode('private allocation'),
    });

    await expect(withOpenedAllocationEnvelopeV1({ ...envelope, batchId: 'batch-8' }, recipient, () => 'unexpected'))
      .rejects.toMatchObject({ code: 'ENVELOPE_AUTH_FAILED' });
    await expect(withOpenedAllocationEnvelopeV1(envelope, otherRecipient, () => 'unexpected'))
      .rejects.toMatchObject({ code: 'UNKNOWN_RECIPIENT_KEY' });
  });

  it('rejects malformed headers, ciphertext and empty plaintext', async () => {
    const recipient = await generateAllocationRecipientDecryptionKeyV1('recipient-key-1');
    await expect(sealAllocationEnvelopeV1({
      header: { ...header(), allocationId: 'not-a-uuid' }, recipientKey: allocationRecipientPublicKeyV1(recipient), plaintext: encoder.encode('x'),
    })).rejects.toMatchObject({ code: 'INVALID_ALLOCATION_ID' });
    await expect(sealAllocationEnvelopeV1({
      header: header(), recipientKey: allocationRecipientPublicKeyV1(recipient), plaintext: new Uint8Array(),
    })).rejects.toMatchObject({ code: 'INVALID_PLAINTEXT' });
  });

  it('clears recipient plaintext if the consumer fails', async () => {
    const recipient = await generateAllocationRecipientDecryptionKeyV1('recipient-key-1');
    const envelope = await sealAllocationEnvelopeV1({
      header: header(), recipientKey: allocationRecipientPublicKeyV1(recipient), plaintext: encoder.encode('private allocation'),
    });
    let consumed: Uint8Array | undefined;

    await expect(withOpenedAllocationEnvelopeV1(envelope, recipient, plaintext => {
      consumed = plaintext;
      throw new Error('consumer failed');
    })).rejects.toThrow('consumer failed');
    expect([...consumed ?? []].every(value => value === 0)).toBe(true);
  });
});
