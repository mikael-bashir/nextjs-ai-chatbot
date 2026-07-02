import 'server-only';

import Redis from 'ioredis';

// Shared ioredis singleton (mirrors the pattern in lib/pricing.ts).
let _redis: Redis | null = null;
export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL!, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });
  }
  return _redis;
}

// The queue that successfully-generated + Lean-verified problems land in.
export const PROBLEM_QUEUE_KEY = 'competemath:problems:queue';

export async function pushProblem(problem: unknown): Promise<number> {
  const redis = getRedis();
  // LPUSH so consumers can RPOP in FIFO order; return the new queue length.
  return redis.lpush(PROBLEM_QUEUE_KEY, JSON.stringify(problem));
}

export async function queueLength(): Promise<number> {
  return getRedis().llen(PROBLEM_QUEUE_KEY);
}
