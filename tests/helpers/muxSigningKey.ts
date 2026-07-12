// Test-only Mux signing keypair, generated once per vitest worker.
//
// tests/setup.ts seeds MUX_SIGNING_KEY_ID / MUX_SIGNING_PRIVATE_KEY from these
// values BEFORE src/env.ts is imported, so tokens the app signs during tests
// can be verified in assertions against `testMuxPublicKeyPem`. Because module
// instances are shared within a worker, setup and test files always see the
// same keypair.
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

export const TEST_MUX_SIGNING_KEY_ID = 'test-mux-signing-key-id';

export const testMuxPublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

// Mux dashboards hand out the private key base64-encoded; env stores it the same way.
export const testMuxPrivateKeyBase64 = Buffer.from(
  privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
).toString('base64');
