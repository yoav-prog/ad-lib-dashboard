"""
check_db.py - verify the database is reachable and the schema is in place.

Run:  python check_db.py

Reads DATABASE_URL from the environment. For local development it loads a
.env.local (and .env, if present) via python-dotenv; in CI the variables are
injected as secrets instead. This is a read-only check; it writes nothing.
"""

import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    _here = Path(__file__).resolve().parent
    load_dotenv(_here / '.env')                        # base, if present
    load_dotenv(_here / '.env.local', override=True)   # this project keeps secrets here
except ImportError:
    pass  # fine if you exported the vars in your shell instead

import db

EXPECTED = ('ads', 'domains', 'runs')


def main():
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            select table_name from information_schema.tables
             where table_schema = 'public' and table_name = any(%s)
             order by table_name
            """,
            (list(EXPECTED),),
        )
        found = tuple(r['table_name'] for r in cur.fetchall())
        print('Tables found:', ', '.join(found) or '(none)')

        for t in found:
            cur.execute(f'select count(*) as n from {t}')
            print(f'  {t:8} {cur.fetchone()["n"]:>6} rows')

    if found == EXPECTED:
        print('\nOK: database reachable and schema is present.')
    else:
        missing = [t for t in EXPECTED if t not in found]
        print(f'\nMISSING tables: {missing}. Did the migration run?')


if __name__ == '__main__':
    main()
