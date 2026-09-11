import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const schemaPath = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));

function modelFieldNames(schema: string, model: string): string[] {
  const match = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'mu').exec(schema);
  if (!match?.[1]) throw new Error(`${model} model is missing`);
  return match[1]
    .split('\n')
    .map((line) => /^\s{2}([A-Za-z][A-Za-z0-9]*)\s/.exec(line)?.[1])
    .filter((field): field is string => field !== undefined);
}

describe('OrderEnvelope Prisma schema privacy boundary', () => {
  it('contains encrypted transport fields and no plaintext order fields', () => {
    const fields = modelFieldNames(readFileSync(schemaPath, 'utf8'), 'OrderEnvelope');

    expect(fields).toEqual(expect.arrayContaining([
      'clientRequestId',
      'commitment',
      'encryptionKeyId',
      'envelopeVersion',
      'envelopeAlgorithm',
      'ephemeralPublicKey',
      'envelopeSalt',
      'envelopeNonce',
      'ciphertext',
      'clientSignature',
    ]));
    expect(fields).not.toEqual(expect.arrayContaining([
      'side',
      'price',
      'quantity',
      'limitPrice',
      'minFill',
      'blinding',
      'ownerSecret',
      'opening',
    ]));
  });

  it('keeps chain reconciliation records limited to sanitized public evidence', () => {
    const fields = modelFieldNames(readFileSync(schemaPath, 'utf8'), 'OrderAdmissionReconciliation');

    expect(fields).toEqual(expect.arrayContaining([
      'orderId',
      'state',
      'decisionCode',
      'decisionHash',
      'sourceIds',
      'admissionTxId',
      'leafIndex',
    ]));
    expect(fields).not.toEqual(expect.arrayContaining([
      'side',
      'price',
      'quantity',
      'limitPrice',
      'minFill',
      'blinding',
      'ownerSecret',
      'opening',
      'walletIdentity',
      'signature',
    ]));
  });

  it('keeps admission submission attempts limited to public metadata', () => {
    const fields = modelFieldNames(readFileSync(schemaPath, 'utf8'), 'OrderAdmissionSubmission');
    expect(fields).toEqual(expect.arrayContaining([
      'orderId', 'state', 'publicTxId', 'lastErrorCode',
    ]));
    expect(fields).not.toEqual(expect.arrayContaining([
      'ciphertext', 'clientSignature', 'side', 'price', 'quantity', 'blinding',
      'ownerSecret', 'walletSeed', 'privateKey',
    ]));
  });
});
