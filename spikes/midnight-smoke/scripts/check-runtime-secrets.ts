import assert from 'node:assert/strict';

import { getPrivateStatePassword } from '../src/runtime-secrets';

const previous = process.env.PRIVATE_STATE_PASSWORD;

try {
  delete process.env.PRIVATE_STATE_PASSWORD;
  assert.throws(() => getPrivateStatePassword(), /PRIVATE_STATE_PASSWORD is required/u);

  process.env.PRIVATE_STATE_PASSWORD = 'aaaaaaaaaaaaaaaa';
  assert.throws(() => getPrivateStatePassword());

  const syntheticValidPassword = 'TestOnly!9_Zebra';
  process.env.PRIVATE_STATE_PASSWORD = syntheticValidPassword;
  assert.equal(getPrivateStatePassword(), syntheticValidPassword);
} finally {
  if (previous === undefined) delete process.env.PRIVATE_STATE_PASSWORD;
  else process.env.PRIVATE_STATE_PASSWORD = previous;
}

console.log('Runtime private-state password gate: verified against installed SDK policy');
