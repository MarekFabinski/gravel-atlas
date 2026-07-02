import postgres from 'postgres';
import { runMigrations } from '../lib/migrate';

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL not set');
const sql = postgres(url, { ssl: url.includes('localhost') ? false : 'require', max: 1 });

runMigrations(sql).then(
  async () => { console.log('migrations up to date'); await sql.end(); },
  async (e) => { console.error(e); await sql.end(); process.exit(1); }
);
