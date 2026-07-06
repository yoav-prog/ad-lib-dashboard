"""
seed_verticals.py - load the vertical/offer taxonomy into the verticals table.

Run:  python seed_verticals.py

Reads distinct column-A values from the Offer Naming CSV (the same list the old
scraper read from 'Offer Naming!A2:A') and upserts them. Idempotent.
"""

import csv
from pathlib import Path

try:
    from dotenv import load_dotenv
    _here = Path(__file__).resolve().parent
    load_dotenv(_here / '.env')
    load_dotenv(_here / '.env.local', override=True)
except ImportError:
    pass

import db

CSV_PATH = Path(r'C:\Projects\ad-lib-dashboard\New-Keywords-2023 - Offer Naming (1).csv')


def load_verticals(path):
    """Distinct, order-preserving column-A values, skipping the header row."""
    seen = {}
    with open(path, encoding='utf-8', newline='') as f:
        reader = csv.reader(f)
        next(reader, None)  # header row
        for row in reader:
            if row and row[0].strip():
                seen.setdefault(row[0].strip(), None)
    return list(seen.keys())


def main():
    names = load_verticals(CSV_PATH)
    print(f'{len(names)} distinct verticals in CSV column A')
    with db.connect() as conn, conn.cursor() as cur:
        cur.executemany(
            'insert into verticals (name) values (%s) on conflict (name) do nothing',
            [(n,) for n in names],
        )
        cur.execute('select count(*) as n from verticals')
        print('verticals now in DB:', cur.fetchone()['n'])


if __name__ == '__main__':
    main()
