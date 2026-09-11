import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const openApiPath = fileURLToPath(new URL('../../../openapi/lunarveil.openapi.yaml', import.meta.url));

describe('M6 OpenAPI contract', () => {
  it('documents the implemented ciphertext-only route surface', () => {
    const document = readFileSync(openApiPath, 'utf8');
    expect(document).toContain('/healthz:');
    expect(document).toContain('/readyz:');
    expect(document).toContain('/v1/matcher-key:');
    expect(document).toContain('/v1/markets:');
    expect(document).toContain('/v1/markets/{marketId}/epoch:');
    expect(document).toContain('/v1/system/status:');
    expect(document).toContain('/v1/sessions/challenges:');
    expect(document).toContain('/v1/sessions/verify:');
    expect(document).toContain('/v1/orders:');
    expect(document).toContain('ephemeralPublicKey:');
    expect(document).toContain('X25519-HKDF-SHA256-AES-256-GCM');
    expect(document).not.toContain('/v1/session/challenge:');
    expect(document).not.toContain('chainAdmission:');
  });
});
