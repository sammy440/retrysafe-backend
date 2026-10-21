// Compile-time check: real client types are accepted.
import Redis from "ioredis";
import { Pool } from "pg";
import { postgresGuard, redisGuard } from "../src";
export const r = redisGuard(new Redis({ lazyConnect: true }));
export const p = postgresGuard(new Pool());
