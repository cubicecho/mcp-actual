import { describe, expect, it } from 'vitest';
import { errorChainMessage, errorMessage } from './errors.ts';

describe('errorMessage', () => {
  it('stringifies non-Error throws', () => {
    expect(errorMessage('boom')).toBe('boom');
  });
});

describe('errorChainMessage', () => {
  it('joins an error with its causes', () => {
    const err = new Error('Failed to open budget "abc"', { cause: new Error('SyncError') });
    expect(errorChainMessage(err)).toBe('Failed to open budget "abc": SyncError');
  });

  it('does not repeat a cause the wrapper already quotes', () => {
    const cause = new Error('Authentication failed: network-failure');
    const err = new Error(`Failed to connect: ${cause.message}`, { cause });
    expect(errorChainMessage(err)).toBe('Failed to connect: Authentication failed: network-failure');
  });

  it('returns the message unchanged when there is no cause', () => {
    expect(errorChainMessage(new Error('plain'))).toBe('plain');
  });
});
