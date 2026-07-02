import fs from 'node:fs';
import path from 'node:path';
import type postgres from 'postgres';

export async function runMigrations(sql: postgres.Sql) {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)`;
  const dir = path.join(process.cwd(), 'migrations');
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const done = await sql`SELECT 1 FROM schema_migrations WHERE name = ${file}`;
    if (done.length) continue;
    await sql.unsafe(fs.readFileSync(path.join(dir, file), 'utf8'));
    await sql`INSERT INTO schema_migrations (name) VALUES (${file})`;
    console.log(`applied ${file}`);
  }
}
