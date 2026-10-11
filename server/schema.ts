import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const user = sqliteTable('user', {
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  id: text('id').primaryKey(),
  image: text('image'),
  name: text('name').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const session = sqliteTable('session', {
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  id: text('id').primaryKey(),
  ipAddress: text('ip_address'),
  token: text('token').notNull().unique(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = sqliteTable('account', {
  accessToken: text('access_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  accountId: text('account_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  id: text('id').primaryKey(),
  idToken: text('id_token'),
  password: text('password'),
  providerId: text('provider_id').notNull(),
  refreshToken: text('refresh_token'),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const verification = sqliteTable('verification', {
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  value: text('value').notNull(),
})

export const solanaWallet = sqliteTable('solana_wallet', {
  address: text('address').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  id: text('id').primaryKey(),
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const miningProgress = sqliteTable('mining_counter', {
  copper: integer('copper').notNull().default(0),
  health: integer('health').notNull().default(10),
  revision: integer('count').notNull().default(0),
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  xp: integer('xp').notNull().default(0),
})

export const miningAction = sqliteTable(
  'mining_action',
  {
    actionId: text('action_id').notNull(),
    copper: integer('copper').notNull(),
    health: integer('health').notNull(),
    revision: integer('revision').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    xp: integer('xp').notNull(),
  },
  (table) => [primaryKey({ columns: [table.actionId, table.userId] })],
)
