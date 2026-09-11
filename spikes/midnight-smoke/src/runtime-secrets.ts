import { validatePassword } from '@midnight-ntwrk/midnight-js-utils';

function requireRuntimeSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required. Supply it through your shell or secret manager; Lunarveil never stores it.`);
  }
  return value;
}

export function getPrivateStatePassword(): string {
  const password = requireRuntimeSecret('PRIVATE_STATE_PASSWORD');
  validatePassword(password);
  return password;
}
