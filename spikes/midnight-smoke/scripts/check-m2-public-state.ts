import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getContractDeployment,
  getDeployment,
  loadState,
  recordContractDeployment,
  recordDeployment,
} from '../src/network';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'lunarveil-m2-public-state-'));

try {
  recordDeployment('preview', 'hello-address', 'hello-deployer', { cwd: temporaryDirectory });
  recordContractDeployment(
    'preview',
    'lunarveil-order-commitment-v1',
    'm2-address',
    'm2-deployer',
    { cwd: temporaryDirectory },
  );

  assert.equal(getDeployment('preview', { cwd: temporaryDirectory })?.address, 'hello-address');
  assert.equal(
    getContractDeployment('preview', 'lunarveil-order-commitment-v1', { cwd: temporaryDirectory })?.address,
    'm2-address',
  );
  assert.equal(loadState({ cwd: temporaryDirectory })?.version, 2);

  const raw = readFileSync(join(temporaryDirectory, '.midnight-state.json'), 'utf8');
  assert.equal(raw.includes('seed'), false);
  assert.equal(raw.includes('password'), false);
  assert.equal(raw.includes('privateState'), false);
} finally {
  const resolved = realpathSync(temporaryDirectory);
  const resolvedTemp = realpathSync(tmpdir());
  if (!resolved.startsWith(`${resolvedTemp}\\`) && !resolved.startsWith(`${resolvedTemp}/`)) {
    throw new Error('Refusing to remove a test directory outside the system temp directory.');
  }
  rmSync(resolved, { recursive: true, force: true });
}

console.log('M2 named public deployment state and privacy boundary: verified');
