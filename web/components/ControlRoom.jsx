'use client';

import { useState } from 'react';
import { s } from '@/lib/style';
import { A, MONO, relTime, pad } from '@/lib/ui';
import { addDomain, updateDomain } from '@/app/actions';

const CADENCES = ['hourly', 'daily', 'weekly', 'paused'];

export default function ControlRoom({ ads, domains, runs, NOW }) {
  const [q, setQ] = useState('');
  const [country, setCountry] = useState('ALL');
  const [maxAds, setMaxAds] = useState(100);
  const [busy, setBusy] = useState(false);

  const adsByDomain = {};
  ads.forEach((a) => { if (a.domain) adsByDomain[a.domain] = (adsByDomain[a.domain] || 0) + 1; });

  const lastCompleted = runs.find((r) => r.status === 'completed' && r.finished_at);
  const dueTimes = domains.filter((d) => d.enabled && d.cadence !== 'paused' && d.next_run_at).map((d) => d.next_run_at).sort();
  const nextDue = dueTimes[0];

  const submit = async () => {
    if (!q.trim() || busy) return;
    setBusy(true);
    try {
      await addDomain({ query: q.trim(), country: country.trim() || 'ALL', max_ads: Number(maxAds) || 100 });
      setQ('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={s('max-width:1100px')}>
      <div style={s('display:flex;align-items:center;height:44px;padding:0 24px;border-bottom:1px solid rgba(255,255,255,.06)')}>
        <span style={s(`font-family:${MONO};font-size:12px;letter-spacing:1px;color:#E7E8EA`)}>CONTROL ROOM</span>
      </div>

      {/* run summary */}
      <div style={s('padding:22px 24px;border-bottom:1px solid rgba(255,255,255,.06)')}>
        <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase;margin-bottom:12px')}>Scrape Status</div>
        <div style={s('display:flex;gap:34px')}>
          <Stat label="Next Due" value={nextDue ? relFuture(nextDue, NOW) : '-'} color={A} />
          <Stat label="Last Run" value={lastCompleted ? relTime(NOW - new Date(lastCompleted.finished_at).getTime()) : 'never'} color="#C6C9CE" />
          <Stat label="Last New / Errors" value={lastCompleted ? `+${lastCompleted.ads_new} / ${lastCompleted.errors}` : '-'} color="#C6C9CE" />
          <Stat label="Total Runs" value={pad(runs.length)} color="#C6C9CE" />
        </div>
      </div>

      {/* domains */}
      <div style={s('padding:22px 24px')}>
        <div style={s('display:flex;align-items:center;justify-content:space-between;margin-bottom:12px')}>
          <div style={s('font-size:9.5px;letter-spacing:1.2px;color:#5A5E64;text-transform:uppercase')}>Tracked Domains / Queries</div>
        </div>

        {/* add row */}
        <div style={s('display:flex;gap:8px;margin-bottom:14px')}>
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="competitor.com or keyword"
            style={s(`flex:1;background:#0B0C0E;border:1px solid rgba(255,255,255,.09);color:#E7E8EA;font-size:12px;padding:8px 10px;outline:none`)} />
          <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="ALL"
            style={s(`width:70px;background:#0B0C0E;border:1px solid rgba(255,255,255,.09);color:#E7E8EA;font-family:${MONO};font-size:12px;padding:8px 10px;outline:none;text-align:center`)} />
          <input type="number" value={maxAds} onChange={(e) => setMaxAds(e.target.value)}
            style={s(`width:80px;background:#0B0C0E;border:1px solid rgba(255,255,255,.09);color:#E7E8EA;font-family:${MONO};font-size:12px;padding:8px 10px;outline:none;text-align:center`)} />
          <button onClick={submit} disabled={busy}
            style={s(`font-family:${MONO};font-size:10.5px;color:#0B0C0E;background:${busy ? '#5A5E64' : A};border:none;padding:0 16px;cursor:${busy ? 'default' : 'pointer'}`)}>
            {busy ? 'ADDING...' : '+ ADD'}
          </button>
        </div>

        <div style={s('border:1px solid rgba(255,255,255,.08)')}>
          <div style={s('display:flex;align-items:center;height:28px;padding:0 14px;background:#0D0E11;border-bottom:1px solid rgba(255,255,255,.06);font-size:9.5px;letter-spacing:1px;color:#5A5E64;text-transform:uppercase')}>
            <div style={s('flex:1')}>Domain / Query</div>
            <div style={s('width:80px;text-align:center')}>Country</div>
            <div style={s('width:90px;text-align:right')}>Max Ads</div>
            <div style={s('width:80px;text-align:center')}>Ads Held</div>
            <div style={s('width:110px;text-align:center')}>Cadence</div>
            <div style={s('width:90px;text-align:center')}>Status</div>
          </div>

          {domains.length === 0 && (
            <div style={s('padding:22px 14px;text-align:center;color:#5A5E64;font-size:12px')}>No domains yet. Add one above to start tracking a competitor.</div>
          )}

          {domains.map((d) => (
            <div key={d.id} style={s('display:flex;align-items:center;height:44px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.045)')}>
              <div style={s('flex:1;min-width:0')}>
                <div style={s('font-size:12px;color:#E7E8EA;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{d.query}</div>
              </div>
              <div style={s(`width:80px;text-align:center;font-family:${MONO};font-size:11px;color:#B6B9BE`)}>{d.country}</div>
              <div style={s(`width:90px;text-align:right;font-family:${MONO};font-size:13px;color:#C6C9CE;font-variant-numeric:tabular-nums`)}>{d.max_ads}</div>
              <div style={s(`width:80px;text-align:center;font-family:${MONO};font-size:13px;color:#E7E8EA;font-variant-numeric:tabular-nums`)}>{adsByDomain[d.query] || 0}</div>
              <div style={s('width:110px;display:flex;justify-content:center')}>
                <button onClick={() => updateDomain(d.id, { cadence: CADENCES[(CADENCES.indexOf(d.cadence) + 1) % CADENCES.length] })}
                  style={s(`font-family:${MONO};font-size:10px;color:${d.cadence === 'paused' ? '#6C7076' : A};background:none;border:1px solid rgba(255,255,255,.12);padding:3px 10px;cursor:pointer;letter-spacing:.5px`)}>
                  {d.cadence.toUpperCase()}
                </button>
              </div>
              <div style={s('width:90px;text-align:center')}>
                <button onClick={() => updateDomain(d.id, { enabled: !d.enabled })}
                  style={s(`display:inline-flex;align-items:center;gap:5px;background:none;border:1px solid ${d.enabled ? 'rgba(232,163,61,.4)' : 'rgba(255,255,255,.12)'};padding:3px 8px;cursor:pointer`)}>
                  <span style={s(`width:6px;height:6px;border-radius:50%;background:${d.enabled ? A : '#5A5E64'}`)} />
                  <span style={s(`font-family:${MONO};font-size:9.5px;color:${d.enabled ? A : '#6C7076'}`)}>{d.enabled ? 'ACTIVE' : 'PAUSED'}</span>
                </button>
              </div>
            </div>
          ))}
        </div>
        <div style={s('font-size:10px;color:#5A5E64;line-height:1.6;margin-top:12px')}>
          Cadence and status write to the database immediately. The scheduled runner (added next) reads these to decide what to scrape and when.
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div>
      <div style={s('font-size:9px;letter-spacing:.8px;color:#5A5E64;text-transform:uppercase')}>{label}</div>
      <div style={s(`font-family:${MONO};font-size:14px;color:${color};margin-top:3px`)}>{value}</div>
    </div>
  );
}

function relFuture(iso, now) {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'due now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}
