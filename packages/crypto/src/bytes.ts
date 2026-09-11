const HEX_32_PATTERN = /^[0-9a-f]{64}$/;

export function assertBytes32(value: Uint8Array, name: string): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`${name} must be exactly 32 bytes`);
  }
}

export function bytes32FromHex(value: string, name = "value"): Uint8Array {
  if (!HEX_32_PATTERN.test(value)) {
    throw new TypeError(`${name} must be 64 lowercase hexadecimal characters`);
  }
  return Uint8Array.from(Buffer.from(value, "hex"));
}

export function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

export function copyBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}
