import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const validEnv = {
  ACTUAL_SERVER_URL: 'https://budget.example.com',
  ACTUAL_PASSWORD: 'hunter2',
  ACTUAL_SYNC_ID: 'ac3f1b1e-0000-4000-8000-000000000000',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('applies defaults for the optional variables', () => {
    const config = loadConfig({ ...validEnv });
    expect(config.dataDir).toBe(path.resolve('./data'));
    expect(config.port).toBe(3000);
    expect(config.authToken).toBeNull();
    expect(config.encryptionPassword).toBeUndefined();
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
    expect(loadConfig({ ...validEnv, MCP_ACTUAL_TOKEN: '   ' }).authToken).toBeNull();
  });

  it('names every missing variable in one error', () => {
    expect(() => loadConfig({})).toThrowError(/ACTUAL_SERVER_URL[\s\S]*ACTUAL_PASSWORD[\s\S]*ACTUAL_SYNC_ID/);
  });

  it('rejects a server url that is not a url', () => {
    expect(() => loadConfig({ ...validEnv, ACTUAL_SERVER_URL: 'budget.example.com' })).toThrowError(
      /ACTUAL_SERVER_URL/,
    );
  });
});
