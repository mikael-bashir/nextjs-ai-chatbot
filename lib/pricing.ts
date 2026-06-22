import 'server-only';
import Redis from 'ioredis';

// ---------------------------------------------------------------------------
// Redis client (singleton)
// ---------------------------------------------------------------------------

let _redis: Redis | null = null;
function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 2 });
  }
  return _redis;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelPricing {
  inputPer1M: number;   // USD per 1M input tokens
  outputPer1M: number;  // USD per 1M output tokens
}

// ---------------------------------------------------------------------------
// Seed data — source: x.ai/api and public pricing pages (June 2026)
// LiteLLM model names used by the Python agent
// ---------------------------------------------------------------------------

const SEED_PRICES: Record<string, ModelPricing> = {
  // Paid models — billed per token via XAI_API_KEY
  'grok-3-fast':              { inputPer1M: 0.60, outputPer1M: 2.40 },
  'grok-4-fast':              { inputPer1M: 0.20, outputPer1M: 0.40 },
  'grok-4':                   { inputPer1M: 3.0,  outputPer1M: 15.0 },
  'grok-4.3':                 { inputPer1M: 1.25, outputPer1M: 2.50 },
  'grok-2-vision-1212':       { inputPer1M: 2.0,  outputPer1M: 10.0 },
  'grok-2-1212':              { inputPer1M: 2.0,  outputPer1M: 10.0 },
  // Free tier — no credit deduction, entry here only for cost estimation/audit
  'grok-free-pool':           { inputPer1M: 0.0,  outputPer1M: 0.0 },
  'xai/grok-4-1-fast-reasoning': { inputPer1M: 0.0, outputPer1M: 0.0 },
};

const PRICING_KEY_PREFIX = 'pricing:model:';
const MARKUP_KEY = 'pricing:markup';
const USD_GBP_KEY = 'pricing:usd_gbp_rate';
// Seed values — only used by seedPricingIfEmpty(), never as runtime fallbacks
const SEED_MARKUP = 1.2;
const SEED_USD_GBP = 0.79;

// ---------------------------------------------------------------------------
// Seed / initialise prices into Redis (idempotent — only sets if not present)
// ---------------------------------------------------------------------------

export async function seedPricingIfEmpty(): Promise<void> {
  const redis = getRedis();
  await redis.connect().catch(() => {}); // no-op if already connected
  const pipeline = redis.pipeline();

  for (const [modelId, prices] of Object.entries(SEED_PRICES)) {
    const key = `${PRICING_KEY_PREFIX}${modelId}`;
    // NX = only set if key does not exist
    pipeline.set(key, JSON.stringify(prices), 'EX', 86400 * 30, 'NX');
  }
  pipeline.set(MARKUP_KEY, String(SEED_MARKUP), 'NX');
  pipeline.set(USD_GBP_KEY, String(SEED_USD_GBP), 'EX', 86400, 'NX');

  await pipeline.exec();
}

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

const REDIS_TIMEOUT_MS = 60_000;

async function redisGet(key: string): Promise<string> {
  const redis = getRedis();
  await redis.connect().catch(() => {});
  const result = await Promise.race([
    redis.get(key),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Redis timeout after ${REDIS_TIMEOUT_MS / 1000}s fetching key: ${key}`)), REDIS_TIMEOUT_MS),
    ),
  ]);
  if (result === null) throw new Error(`Redis key not found: ${key}`);
  return result;
}

export async function getModelPricing(modelId: string): Promise<ModelPricing> {
  // Try exact key first, then prefix-match against seeded keys
  const candidates = [modelId, ...Object.keys(SEED_PRICES).filter(
    (k) => modelId.startsWith(k) || k.startsWith(modelId),
  )];

  for (const candidate of candidates) {
    try {
      const raw = await redisGet(`${PRICING_KEY_PREFIX}${candidate}`);
      return JSON.parse(raw) as ModelPricing;
    } catch (err: any) {
      if (err.message?.startsWith('Redis timeout')) throw err;
      // Key not found — try next candidate
    }
  }

  throw new Error(`No pricing found in Redis for model "${modelId}". Seed prices before accepting requests.`);
}

export async function getMarkup(): Promise<number> {
  return Number(await redisGet(MARKUP_KEY));
}

export async function getUsdToGbpRate(): Promise<number> {
  return Number(await redisGet(USD_GBP_KEY));
}

// ---------------------------------------------------------------------------
// Cost calculation
// Returns the amount to deduct in credits (1 credit = £1)
// ---------------------------------------------------------------------------

export async function calculateCreditCost({
  modelId,
  tokensInput,
  tokensOutput,
}: {
  modelId: string;
  tokensInput: number;
  tokensOutput: number;
}): Promise<{ credits: number; rawCostGbp: number; markupFactor: number }> {
  const [pricing, markup, rate] = await Promise.all([
    getModelPricing(modelId),
    getMarkup(),
    getUsdToGbpRate(),
  ]);

  const rawCostUsd =
    (tokensInput / 1_000_000) * pricing.inputPer1M +
    (tokensOutput / 1_000_000) * pricing.outputPer1M;

  const rawCostGbp = rawCostUsd * rate;
  // credits = £ (1 credit = £1), rounded to 6 decimal places
  const credits = Math.round(rawCostGbp * markup * 1_000_000) / 1_000_000;

  return { credits, rawCostGbp, markupFactor: markup };
}

// ---------------------------------------------------------------------------
// Admin helpers — update prices/markup at runtime without a redeploy
// ---------------------------------------------------------------------------

export async function setModelPricing(modelId: string, prices: ModelPricing): Promise<void> {
  const redis = getRedis();
  await redis.connect().catch(() => {});
  await redis.set(`${PRICING_KEY_PREFIX}${modelId}`, JSON.stringify(prices), 'EX', 86400 * 30);
}

export async function setMarkup(factor: number): Promise<void> {
  const redis = getRedis();
  await redis.connect().catch(() => {});
  await redis.set(MARKUP_KEY, String(factor));
}

export async function setUsdToGbpRate(rate: number): Promise<void> {
  const redis = getRedis();
  await redis.connect().catch(() => {});
  await redis.set(USD_GBP_KEY, String(rate), 'EX', 86400);
}
