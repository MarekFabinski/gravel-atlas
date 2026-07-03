import postgres from 'postgres';

const globalForDb = globalThis as unknown as { sql?: postgres.Sql };

const sql =
  globalForDb.sql ??
  postgres(process.env.DATABASE_URL!, {
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : 'require',
    max: process.env.NODE_ENV === 'production' ? 1 : 10,
  });

if (process.env.NODE_ENV !== 'production') globalForDb.sql = sql;

export default sql;
