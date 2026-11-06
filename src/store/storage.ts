/**
 * Where the ledger lives between launches.
 *
 * Deliberately a port rather than a direct call to AsyncStorage. Two
 * reasons, and only one of them is tidiness:
 *
 *   1. The store can be tested with an in-memory adapter, in a plain Node
 *      process, which is how the restart behaviour below gets proven without
 *      a device.
 *   2. The ledger is an append-only operation log. Today it sits in a
 *      key-value store; a log that outgrows that wants SQLite. Keeping the
 *      boundary explicit means that swap touches one file.
 *
 * Every method can fail. Storage on a phone is not a reliable resource: the
 * disk fills, the OS clears app data under pressure, and a write can be cut
 * off by the process being killed. Callers are expected to handle that
 * rather than assume a read returns what the last write put there.
 */

export interface Storage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** For tests, and for a first run before anything has been persisted. */
export class MemoryStorage implements Storage {
  private readonly cells = new Map<string, string>();

  async read(key: string): Promise<string | null> {
    return this.cells.get(key) ?? null;
  }

  async write(key: string, value: string): Promise<void> {
    this.cells.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.cells.delete(key);
  }

  /** Test affordance: simulate the OS clearing app data. */
  wipe(): void {
    this.cells.clear();
  }
}

/**
 * The device-backed adapter.
 *
 * Imported lazily so the pure modules - and therefore the tests - never pull
 * in a native module. A test process that accidentally loads AsyncStorage
 * fails in ways that have nothing to do with the code under test.
 */
export function deviceStorage(): Storage {
  return {
    async read(key) {
      const { default: store } = await import('@react-native-async-storage/async-storage');
      return store.getItem(key);
    },
    async write(key, value) {
      const { default: store } = await import('@react-native-async-storage/async-storage');
      await store.setItem(key, value);
    },
    async remove(key) {
      const { default: store } = await import('@react-native-async-storage/async-storage');
      await store.removeItem(key);
    },
  };
}
