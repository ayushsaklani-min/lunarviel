const DOMAIN_LENGTH = 32;

function paddedDomain(label: string): Uint8Array {
  const encoded = new TextEncoder().encode(label);
  if (encoded.length > DOMAIN_LENGTH) {
    throw new RangeError(`domain label exceeds ${DOMAIN_LENGTH} bytes`);
  }

  const domain = new Uint8Array(DOMAIN_LENGTH);
  domain.set(encoded);
  return domain;
}

// These bytes intentionally match Compact's pad(32, "...") representation.
export const ORDER_COMMITMENT_DOMAIN_V1 = paddedDomain("LUNARVEIL_ORDER_V1");
export const ORDER_NULLIFIER_DOMAIN_V1 = paddedDomain("LUNARVEIL_NULLIFIER_V1");
export const OWNER_AUTHORIZATION_DOMAIN_V1 = paddedDomain("LUNARVEIL_OWNER_V1");
