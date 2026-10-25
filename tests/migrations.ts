import { readFileSync, readdirSync } from 'node:fs';
import { unstable_splitSqlQuery } from 'wrangler';

export async function applyMigrations(db: D1Database, files = readdirSync('migrations').filter(file => file.endsWith('.sql')).sort()) {
  for (const file of files) {
    // Use the same SQL splitter as Wrangler, including CREATE TRIGGER bodies.
    for (const statement of unstable_splitSqlQuery(readFileSync('migrations/' + file, 'utf8'))) await db.prepare(statement).run();
  }
}
