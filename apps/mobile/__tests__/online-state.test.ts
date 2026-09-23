/**
 * The online state TanStack Query and the outbox share (src/lib/query.ts; increment 10 re-review,
 * ruling Y1): expo-network feeds it on every change, and a phone that starts offline is known
 * offline before any change arrives (Android sends none then), unless a change was heard first.
 * An unknown or failed launch read changes nothing, so it can never hold the outbox back.
 */

import { watchNetwork } from '../src/lib/query';

interface State {
  readonly isConnected?: boolean;
}

const mockNetwork: {
  listener: ((state: State) => void) | null;
  read: () => Promise<State>;
  removed: number;
} = { listener: null, read: () => Promise.resolve({}), removed: 0 };

jest.mock('expo-network', () => ({
  addNetworkStateListener: (listener: (state: State) => void) => {
    mockNetwork.listener = listener;
    return {
      remove: () => {
        mockNetwork.removed += 1;
      },
    };
  },
  getNetworkStateAsync: () => mockNetwork.read(),
}));

/** Lets the launch read's `then` run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await Promise.resolve();
  }
}

function hear(state: State): void {
  if (mockNetwork.listener === null) {
    throw new Error('no network listener');
  }
  mockNetwork.listener(state);
}

beforeEach(() => {
  mockNetwork.listener = null;
  mockNetwork.removed = 0;
});

describe('watchNetwork', () => {
  it('knows a phone that starts offline is offline before any change arrives', async () => {
    mockNetwork.read = () => Promise.resolve({ isConnected: false });
    const setOnline = jest.fn();
    const stop = watchNetwork(setOnline);
    await settle();
    expect(setOnline.mock.calls).toEqual([[false]]);
    // Then every change is heard.
    hear({ isConnected: true });
    expect(setOnline.mock.calls).toEqual([[false], [true]]);
    stop();
    expect(mockNetwork.removed).toBe(1);
  });

  it('lets a change heard first win over the launch read', async () => {
    let answer: (state: State) => void = () => undefined;
    mockNetwork.read = () =>
      new Promise<State>((resolve) => {
        answer = resolve;
      });
    const setOnline = jest.fn();
    watchNetwork(setOnline);
    hear({ isConnected: true });
    answer({ isConnected: false });
    await settle();
    expect(setOnline.mock.calls).toEqual([[true]]);
  });

  it.each([
    ['online', () => Promise.resolve({ isConnected: true })],
    ['unknown', () => Promise.resolve({})],
    ['failed', () => Promise.reject(new Error('no network module'))],
  ] as const)('changes nothing when the launch read is %s', async (_name, read) => {
    mockNetwork.read = read;
    const setOnline = jest.fn();
    watchNetwork(setOnline);
    await settle();
    expect(setOnline).not.toHaveBeenCalled();
  });
});
