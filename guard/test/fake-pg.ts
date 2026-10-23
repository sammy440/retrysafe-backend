interface Tx {
  claims: Set<string>;
  writes: string[];
  done: Promise<void>;
  finish: () => void;
}

export class FakePg {
  committedKeys = new Set<string>();
  committedWrites: string[] = [];
  released = 0;
  private locks = new Map<string, Tx>();

  connect = async () => new FakeClient(this);
  query = (text: string, values?: unknown[]) => new FakeClient(this).query(text, values);

  async claim(tx: Tx | undefined, key: string): Promise<number> {
    for (;;) {
      if (this.committedKeys.has(key)) return 0;
      const holder = this.locks.get(key);
      if (holder && holder !== tx) {
        await holder.done;
        continue;
      }
      if (!tx) {
        this.committedKeys.add(key);
        return 1;
      }
      this.locks.set(key, tx);
      tx.claims.add(key);
      return 1;
    }
  }

  end(tx: Tx, commit: boolean): void {
    if (commit) {
      for (const k of tx.claims) this.committedKeys.add(k);
      this.committedWrites.push(...tx.writes);
    }
    for (const k of tx.claims) this.locks.delete(k);
    tx.finish();
  }
}

export class FakeClient {
  private tx: Tx | undefined;
  constructor(private db: FakePg) {}

  async query(text: string, values: unknown[] = []): Promise<{ rowCount: number | null; rows: unknown[] }> {
    await new Promise((r) => setImmediate(r));
    const sql = text.trim().toUpperCase();
    if (sql === "BEGIN") {
      let finish!: () => void;
      const done = new Promise<void>((r) => (finish = r));
      this.tx = { claims: new Set(), writes: [], done, finish };
      return { rowCount: null, rows: [] };
    }
    if (sql === "COMMIT" || sql === "ROLLBACK") {
      if (this.tx) this.db.end(this.tx, sql === "COMMIT");
      this.tx = undefined;
      return { rowCount: null, rows: [] };
    }
    if (/retrysafe_processed_events|processed/i.test(text) && /^INSERT/.test(sql)) {
      return { rowCount: await this.db.claim(this.tx, String(values[0])), rows: [] };
    }
    if (this.tx) this.tx.writes.push(`${text} ${JSON.stringify(values)}`);
    else this.db.committedWrites.push(`${text} ${JSON.stringify(values)}`);
    return { rowCount: 1, rows: [] };
  }

  release(): void {
    this.db.released++;
  }
}

export function fakePrisma(db: FakePg) {
  return {
    queries: [] as string[],
    async $transaction<R>(fn: (tx: unknown) => Promise<R>): Promise<R> {
      const client = await db.connect();
      await client.query("BEGIN");
      const tx = {
        $executeRawUnsafe: async (q: string, ...v: unknown[]) => {
          this.queries.push(q);
          return (await client.query(q, v)).rowCount ?? 0;
        },
        order: { create: async (args: unknown) => client.query("INSERT INTO orders", [args]) },
      };
      try {
        const out = await fn(tx);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    },
  };
}
