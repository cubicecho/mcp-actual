import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const validEnv = {
  ACTUAL_SERVER_URL: 'https://budget.example.com',
  ACTUAL_PASSWORD: 'hunter2',
  ACTUAL_SYNC_ID: 'ac3f1b1e-0000-4000-8000-000000000000',
  // Required: the server refuses to start unauthenticated unless
  // SECURE_LOCAL_NET says that was intended.
  MCP_ACTUAL_TOKEN: 'test-token',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('applies defaults for the optional variables', () => {
    const config = loadConfig({ ...validEnv });
    expect(config.dataDir).toBe(path.resolve('./data'));
    expect(config.port).toBe(3000);
    expect(config.authToken).toBe('test-token');
    expect(config.timeoutMs).toBe(120_000);
    expect(config.encryptionPassword).toBeUndefined();
    expect(config.enableWrites).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'off'])('disables writes with ACTUAL_ENABLE_WRITES=%s', (value) => {
    expect(loadConfig({ ...validEnv, ACTUAL_ENABLE_WRITES: value }).enableWrites).toBe(false);
  });

  it.each(['true', '1', 'yes', 'on'])('enables writes with ACTUAL_ENABLE_WRITES=%s', (value) => {
    expect(loadConfig({ ...validEnv, ACTUAL_ENABLE_WRITES: value }).enableWrites).toBe(true);
  });

  it('rejects an unrecognized write-gate value rather than defaulting it on', () => {
    expect(() => loadConfig({ ...validEnv, ACTUAL_ENABLE_WRITES: 'flase' })).toThrowError(/ACTUAL_ENABLE_WRITES/);
  });

  it('reads the optional variables when set', () => {
    const config = loadConfig({
      ...validEnv,
      DATA_DIR: '/data',
      PORT: '8080',
      MCP_ACTUAL_TOKEN: 'token',
      ACTUAL_ENCRYPTION_PASSWORD: 'e2e',
    });
    expect(config).toMatchObject({ dataDir: '/data', port: 8080, authToken: 'token', encryptionPassword: 'e2e' });
  });

  it('treats a blank variable as unset', () => {
    expect(loadConfig({ ...validEnv, ACTUAL_ENCRYPTION_PASSWORD: '   ' }).encryptionPassword).toBeUndefined();
  });

  it('names every missing variable in one error', () => {
    expect(() => loadConfig({})).toThrowError(/ACTUAL_SERVER_URL[\s\S]*ACTUAL_PASSWORD[\s\S]*ACTUAL_SYNC_ID/);
  });

  describe('the auth requirement', () => {
    const noToken = { ...validEnv, MCP_ACTUAL_TOKEN: undefined } as NodeJS.ProcessEnv;

    it('refuses to start with no token rather than serving the budget openly', () => {
      // Leaving the variable unset is indistinguishable from misspelling it, so
      // starting anyway turned one typo into a silent, open, writable server.
      expect(() => loadConfig(noToken)).toThrowError(/MCP_ACTUAL_TOKEN/);
    });

    it('says writes are on, because that is what makes an open server dangerous', () => {
      expect(() => loadConfig(noToken)).toThrowError(/writes enabled/);
    });

    it('treats a blank token as no token', () => {
      expect(() => loadConfig({ ...validEnv, MCP_ACTUAL_TOKEN: '   ' })).toThrowError(/MCP_ACTUAL_TOKEN/);
    });

    it('allows an unauthenticated server when SECURE_LOCAL_NET says so explicitly', () => {
      expect(loadConfig({ ...noToken, SECURE_LOCAL_NET: 'true' }).authToken).toBeNull();
    });

    it('still requires the opt-in for a read-only server — the data is exposed either way', () => {
      expect(() => loadConfig({ ...noToken, ACTUAL_ENABLE_WRITES: 'false' })).toThrowError(/MCP_ACTUAL_TOKEN/);
    });
  });

  describe('the operation timeout', () => {
    it('rejects a value too small to be a real deadline', () => {
      expect(() => loadConfig({ ...validEnv, ACTUAL_TIMEOUT_MS: '10' })).toThrowError(/ACTUAL_TIMEOUT_MS/);
    });

    it('rejects a non-numeric value rather than falling back silently', () => {
      expect(() => loadConfig({ ...validEnv, ACTUAL_TIMEOUT_MS: 'soon' })).toThrowError(/ACTUAL_TIMEOUT_MS/);
    });

    it('reads an explicit timeout', () => {
      expect(loadConfig({ ...validEnv, ACTUAL_TIMEOUT_MS: '5000' }).timeoutMs).toBe(5000);
    });
  });

  it('rejects a server url that is not a url', () => {
    expect(() => loadConfig({ ...validEnv, ACTUAL_SERVER_URL: 'budget.example.com' })).toThrowError(
      /ACTUAL_SERVER_URL/,
    );
  });
});
