import type { InferSelectModel } from 'drizzle-orm';
import {
  pgTable,
  varchar,
  timestamp,
  json,
  uuid,
  text,
  primaryKey,
  foreignKey,
  boolean,
  integer,
  real,
  unique,
} from 'drizzle-orm/pg-core';

export const user = pgTable('User', {
  id: uuid('id').primaryKey().notNull().defaultRandom(),
  email: varchar('email', { length: 64 }),
  username: varchar('username', { length: 32 }).unique(),
});

export type User = InferSelectModel<typeof user>;

export const chat = pgTable('Chat', {
  id: uuid('id').primaryKey().notNull().defaultRandom(),
  createdAt: timestamp('createdAt').notNull(),
  title: text('title').notNull(),
  userId: uuid('userId')
    .notNull()
    .references(() => user.id),
  visibility: varchar('visibility', { enum: ['public', 'private'] })
    .notNull()
    .default('private'),
});

export type Chat = InferSelectModel<typeof chat>;

// DEPRECATED: The following schema is deprecated and will be removed in the future.
// Read the migration guide at https://github.com/vercel/ai-chatbot/blob/main/docs/04-migrate-to-parts.md
export const messageDeprecated = pgTable('Message', {
  id: uuid('id').primaryKey().notNull().defaultRandom(),
  chatId: uuid('chatId')
    .notNull()
    .references(() => chat.id),
  role: varchar('role').notNull(),
  content: json('content').notNull(),
  createdAt: timestamp('createdAt').notNull(),
});

export type MessageDeprecated = InferSelectModel<typeof messageDeprecated>;

export const message = pgTable('Message_v2', {
  id: uuid('id').primaryKey().notNull().defaultRandom(),
  chatId: uuid('chatId')
    .notNull()
    .references(() => chat.id),
  role: varchar('role').notNull(),
  parts: json('parts').notNull(),
  attachments: json('attachments').notNull(),
  createdAt: timestamp('createdAt').notNull(),
});

export type DBMessage = InferSelectModel<typeof message>;

// DEPRECATED: The following schema is deprecated and will be removed in the future.
// Read the migration guide at https://github.com/vercel/ai-chatbot/blob/main/docs/04-migrate-to-parts.md
export const voteDeprecated = pgTable(
  'Vote',
  {
    chatId: uuid('chatId')
      .notNull()
      .references(() => chat.id),
    messageId: uuid('messageId')
      .notNull()
      .references(() => messageDeprecated.id),
    isUpvoted: boolean('isUpvoted').notNull(),
  },
  (table) => {
    return {
      pk: primaryKey({ columns: [table.chatId, table.messageId] }),
    };
  },
);

export type VoteDeprecated = InferSelectModel<typeof voteDeprecated>;

export const vote = pgTable(
  'Vote_v2',
  {
    chatId: uuid('chatId')
      .notNull()
      .references(() => chat.id),
    messageId: uuid('messageId')
      .notNull()
      .references(() => message.id),
    isUpvoted: boolean('isUpvoted').notNull(),
  },
  (table) => {
    return {
      pk: primaryKey({ columns: [table.chatId, table.messageId] }),
    };
  },
);

export type Vote = InferSelectModel<typeof vote>;

export const document = pgTable(
  'Document',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    createdAt: timestamp('createdAt').notNull(),
    title: text('title').notNull(),
    content: text('content'),
    kind: varchar('kind', { enum: ['text', 'code', 'image', 'sheet'] })
      .notNull()
      .default('text'),
    userId: uuid('userId')
      .notNull()
      .references(() => user.id),
  },
  (table) => {
    return {
      pk: primaryKey({ columns: [table.id, table.createdAt] }),
    };
  },
);

export type Document = InferSelectModel<typeof document>;

export const suggestion = pgTable(
  'Suggestion',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    documentId: uuid('documentId').notNull(),
    documentCreatedAt: timestamp('documentCreatedAt').notNull(),
    originalText: text('originalText').notNull(),
    suggestedText: text('suggestedText').notNull(),
    description: text('description'),
    isResolved: boolean('isResolved').notNull().default(false),
    userId: uuid('userId')
      .notNull()
      .references(() => user.id),
    createdAt: timestamp('createdAt').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id] }),
    documentRef: foreignKey({
      columns: [table.documentId, table.documentCreatedAt],
      foreignColumns: [document.id, document.createdAt],
    }),
  }),
);

export type Suggestion = InferSelectModel<typeof suggestion>;

export const mcpServers = pgTable('MCPServer', {
  id: uuid('id').primaryKey().notNull().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  url: text('url').notNull(),
  description: text('description'),
  authType: varchar('authType', { enum: ['none', 'bearer', 'oauth', 'apikey'] })
    .notNull()
    .default('none'),
  credentials: json('credentials'), // Encrypted credentials storage
  flaskServerId: varchar('flaskServerId', { length: 255 }), // Links to Flask backend server ID
  isActive: boolean('isActive').notNull().default(true),
  userId: uuid('userId')
    .notNull()
    .references(() => user.id),
  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
});

export type MCPServer = InferSelectModel<typeof mcpServers>;

// Per-user configuration for the Local Claude Agent feature.
// One row per user (see the unique constraint on userId). Stores how this
// user's locally-installed Claude Code CLI should be invoked by the server.
export const localClaudeAgentConfig = pgTable(
  'LocalClaudeAgentConfig',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    userId: uuid('userId')
      .notNull()
      .references(() => user.id),
    // Path to the `claude` executable on the host running this server.
    binaryPath: varchar('binaryPath', { length: 1024 })
      .notNull()
      .default('claude'),
    // Directory the agent runs in (its default cwd / project root). Null = server cwd.
    workingDirectory: text('workingDirectory'),
    // Model override passed via `--model`. Null = use the CLI's configured default.
    model: varchar('model', { length: 128 }),
    // Maps to `--permission-mode`.
    permissionMode: varchar('permissionMode', {
      enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
    })
      .notNull()
      .default('default'),
    // Comma-separated tool allowlist passed via `--allowedTools`. Null = no restriction.
    allowedTools: text('allowedTools'),
    // Maps to `--max-turns`. Null = CLI default.
    maxTurns: integer('maxTurns'),
    // Hard wall-clock timeout for a single run, in milliseconds.
    timeoutMs: integer('timeoutMs').notNull().default(120000),
    // Appended to the system prompt via `--append-system-prompt`.
    systemPromptAppend: text('systemPromptAppend'),
    // Advanced: extra raw CLI flags, stored as a JSON string[] (escape hatch).
    extraArgs: json('extraArgs'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('createdAt').notNull(),
    updatedAt: timestamp('updatedAt').notNull(),
  },
  (table) => ({
    uniqueUser: unique('LocalClaudeAgentConfig_userId_unique').on(table.userId),
  }),
);

export type LocalClaudeAgentConfig = InferSelectModel<
  typeof localClaudeAgentConfig
>;

// balance stored as real (fractional credits). 1.0 credit = £1.
export const userCredits = pgTable('UserCredits', {
  userId: uuid('userId')
    .primaryKey()
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  balance: real('balance').notNull().default(0),
  updatedAt: timestamp('updatedAt').notNull(),
});

export type UserCredits = InferSelectModel<typeof userCredits>;

export const creditTransactions = pgTable('CreditTransaction', {
  id: uuid('id').primaryKey().notNull().defaultRandom(),
  userId: uuid('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  // amount in credits (positive = add, negative = deduct). 1.0 credit = £1.
  amount: real('amount').notNull(),
  type: varchar('type', {
    length: 32,
    enum: ['purchase', 'usage', 'refund', 'grant'],
  }).notNull(),
  description: text('description').notNull(),
  createdAt: timestamp('createdAt').notNull(),
  // audit fields — populated for usage transactions
  tokensInput: integer('tokensInput'),
  tokensOutput: integer('tokensOutput'),
  modelId: varchar('modelId', { length: 128 }),
  rawCostGbp: real('rawCostGbp'),
  markupFactor: real('markupFactor'),
});

export type CreditTransaction = InferSelectModel<typeof creditTransactions>;

export const stripeCustomers = pgTable('StripeCustomer', {
  userId: uuid('userId')
    .primaryKey()
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  stripeCustomerId: varchar('stripeCustomerId', { length: 255 }).notNull(),
  createdAt: timestamp('createdAt').notNull(),
});

export type StripeCustomer = InferSelectModel<typeof stripeCustomers>;

export const stripeSubscriptions = pgTable('StripeSubscription', {
  id: uuid('id').primaryKey().notNull().defaultRandom(),
  userId: uuid('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  stripeSubscriptionId: varchar('stripeSubscriptionId', {
    length: 255,
  }).notNull(),
  planId: varchar('planId', { length: 50 }).notNull(),
  status: varchar('status', {
    length: 50,
    enum: ['active', 'cancelled', 'past_due', 'incomplete'],
  }).notNull(),
  currentPeriodEnd: timestamp('currentPeriodEnd').notNull(),
  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
});

export type StripeSubscription = InferSelectModel<typeof stripeSubscriptions>;

// Metadata for problems generated by the admin pipeline. The Redis queues carry
// only what each consumer needs; the Lean theorem + verified proof (and other
// internal fields) live here, written when a problem is promoted to prod.
export const generatedProblem = pgTable('GeneratedProblem', {
  id: uuid('id').primaryKey().notNull().defaultRandom(),
  problemId: varchar('problemId', { length: 128 }),
  questionTitle: text('questionTitle'),
  subtitle: text('subtitle'),
  problem: text('problem'),
  answer: text('answer'),
  difficulty: varchar('difficulty', { length: 32 }),
  points: integer('points'),
  insight: text('insight'),
  lean: text('lean').notNull(),
  proof: text('proof').notNull(),
  toolchain: varchar('toolchain', { length: 128 }),
  promotedAt: timestamp('promotedAt'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
});

export type GeneratedProblem = InferSelectModel<typeof generatedProblem>;

// ---------------------------------------------------------------------------
// Leak API service — customers authenticate to the public /v1 API with a
// bearer API key (not a browser session). We store only the SHA-256 hash of
// the secret; the plaintext is shown exactly once, at creation time.
// ---------------------------------------------------------------------------
export const apiKey = pgTable('ApiKey', {
  id: uuid('id').primaryKey().notNull().defaultRandom(),
  userId: uuid('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  // Human label so a user can tell keys apart (e.g. "production", "laptop").
  name: varchar('name', { length: 64 }).notNull().default('default'),
  // SHA-256 (hex) of the full secret. Unique so a lookup can be a single eq().
  keyHash: varchar('keyHash', { length: 64 }).notNull().unique(),
  // Non-secret display prefix, e.g. "leak_sk_9f2a…" for the dashboard list.
  prefix: varchar('prefix', { length: 24 }).notNull(),
  lastUsedAt: timestamp('lastUsedAt'),
  revokedAt: timestamp('revokedAt'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
});

export type ApiKey = InferSelectModel<typeof apiKey>;

// ---------------------------------------------------------------------------
// Deployment queue. One row per submitted problem. The operator's worker
// leases queued jobs (lease + heartbeat so a dead worker's job re-queues),
// proves them, and reports back. Refund-on-failure and the pricing-research
// fields (class, quoted vs charged credits, token usage) live here so we can
// mine historical data to set margins.
// ---------------------------------------------------------------------------
export const problemJob = pgTable('ProblemJob', {
  id: uuid('id').primaryKey().notNull().defaultRandom(),
  userId: uuid('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  // Which key submitted it (null if revoked/deleted later). Not the auth path.
  apiKeyId: uuid('apiKeyId').references(() => apiKey.id, {
    onDelete: 'set null',
  }),
  problem: text('problem').notNull(),
  // Mock jobs skip the prover and resolve to a canned proved result so a new
  // user can exercise the whole submit→poll flow immediately after signup.
  isMock: boolean('isMock').notNull().default(false),
  status: varchar('status', {
    enum: [
      'queued',
      'leased',
      'proving',
      'proved',
      'failed',
      'refunded',
      'cancelled',
    ],
  })
    .notNull()
    .default('queued'),
  // Pricing research: assigned class + the credits held at submit vs finally
  // captured. On failure chargedCredits stays 0 (money-back guarantee).
  pricingClass: varchar('pricingClass', { length: 32 }),
  quotedCredits: real('quotedCredits'),
  chargedCredits: real('chargedCredits'),
  // Worker lease bookkeeping.
  leasedBy: varchar('leasedBy', { length: 128 }),
  leaseExpiresAt: timestamp('leaseExpiresAt'),
  heartbeatAt: timestamp('heartbeatAt'),
  attempts: integer('attempts').notNull().default(0),
  // Result + telemetry for the pricing model.
  proof: text('proof'),
  resultError: text('resultError'),
  tokensInput: integer('tokensInput'),
  tokensOutput: integer('tokensOutput'),
  modelId: varchar('modelId', { length: 128 }),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  leasedAt: timestamp('leasedAt'),
  finishedAt: timestamp('finishedAt'),
});

export type ProblemJob = InferSelectModel<typeof problemJob>;

// ---------------------------------------------------------------------------
// Admin debug log. When an admin drives the prover, we capture the EXACT and
// FULL context handed to the agent — the system prompt the bridge built, the
// resolved MCP tool inventory, the theorem, the model — plus the outcome, so
// we can see precisely what the agent saw when it flails. Admin-only; written
// only for admin sessions.
// ---------------------------------------------------------------------------
export const agentRunLog = pgTable('AgentRunLog', {
  id: uuid('id').primaryKey().notNull().defaultRandom(),
  userId: uuid('userId').references(() => user.id, { onDelete: 'set null' }),
  // Where the run came from: 'playground' | 'acg' | 'queue' | 'decompose' | …
  source: varchar('source', { length: 32 }).notNull().default('playground'),
  theorem: text('theorem').notNull(),
  model: varchar('model', { length: 128 }),
  // The full system prompt the bridge sent to claude (provePrompt output).
  prompt: text('prompt'),
  // Resolved MCP servers + their tool inventory, exactly as attached.
  mcpServers: json('mcpServers'),
  // Outcome, filled in when the run ends.
  verified: boolean('verified'),
  proof: text('proof'),
  finalText: text('finalText'),
  metrics: json('metrics'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
});

export type AgentRunLog = InferSelectModel<typeof agentRunLog>;
