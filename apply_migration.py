"""
apply_migration.py - apply SQL migration(s) to the database.

Run:  python apply_migration.py [filename.sql]

With no argument, applies every file in supabase/migrations in sorted order.
With a filename, applies just that one. Reads DATABASE_URL from .env.local/.env.
Statements are split on ';' after line comments are stripped; this project's SQL
has no ';' or '--' inside string literals, so a simple split is correct here.
"""

import sys
from pathlib import Path

try:
    from dotenv import load_dotenv
    _here = Path(__file__).resolve().parent
    load_dotenv(_here / '.env')
    load_dotenv(_here / '.env.local', override=True)
except ImportError:
    pass

import db

MIG_DIR = Path(__file__).resolve().parent / 'supabase' / 'migrations'


def _statements(sql):
    no_comments = '\n'.join(
        (line[:line.index('--')] if '--' in line else line)
        for line in sql.splitlines()
    )
    for chunk in no_comments.split(';'):
        stmt = chunk.strip()
        if stmt:
            yield stmt


def _apply(cur, path):
    stmts = list(_statements(path.read_text(encoding='utf-8')))
    print(f'{path.name}: applying {len(stmts)} statements')
    for i, stmt in enumerate(stmts, 1):
        label = ' '.join(stmt.split()[:6])
        try:
            cur.execute(stmt)
            print(f'  [{i:>2}/{len(stmts)}] ok   {label} ...')
        except Exception as e:
            print(f'  [{i:>2}/{len(stmts)}] FAIL {label} ...\n        {e}')
            raise


def main():
    files = [MIG_DIR / sys.argv[1]] if len(sys.argv) > 1 else sorted(MIG_DIR.glob('*.sql'))
    with db.connect() as conn, conn.cursor() as cur:
        for path in files:
            _apply(cur, path)
    print('\nMigration(s) applied.')


if __name__ == '__main__':
    main()
