import postgres from 'postgres';

// One shared client. The Supabase transaction pooler requires prepared
// statements to be disabled (prepare: false) and SSL.
let _sql;

export function getSql() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set (see ../.env.local)');
    _sql = postgres(url, { prepare: false, ssl: 'require' });
  }
  return _sql;
}
