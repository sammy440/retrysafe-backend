export class MissingEventIdError extends Error {
  constructor(what: string) {
    super(`@retrysafe/guard: no event id found (${what}). Refusing to guess: a generated key would make every retry look new.`);
    this.name = "MissingEventIdError";
  }
}

export function assertKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("@retrysafe/guard: key must be a non-empty string derived from the event (e.g. `stripe:${event.id}`)");
  }
  if (key.length > 512) throw new TypeError("@retrysafe/guard: key is longer than 512 characters");
}
