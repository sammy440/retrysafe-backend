export type OnceResult<T> =
  | { status: "processed"; value: T }
  | { status: "duplicate" }
  | { status: "in-progress" };

export interface Guard<Tx = void> {
  run<T>(key: string, fn: (tx: Tx) => Promise<T> | T): Promise<OnceResult<T>>;
}

export interface GuardOptions {
  prefix?: string;
}
