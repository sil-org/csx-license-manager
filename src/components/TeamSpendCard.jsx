import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { getTeamSpend } from '../lib/team'

// FY runs Oct 1 - Sep 30 (see fy_boundary_months() in
// 70_team_spend.sql) — a calendar month of 10+ means the fiscal year has
// already rolled over to next calendar year.
function currentFiscalYear() {
  const now = new Date()
  return now.getMonth() + 1 >= 10 ? now.getFullYear() + 1 : now.getFullYear()
}

function fyPeriod(fy) {
  return `Oct 1, ${fy - 1} – Sep 30, ${fy}`
}

const money = n => '$' + Math.round(n).toLocaleString('en-US')

// Sits at the top of My Team: a manager's own + reports' spend for one
// fiscal year, split into SuiteKey (what's actually charged to the team),
// Ministry Accounts, and GTIS (sponsored — shown for visibility, not
// charged). The FY arrows step one year at a time; going past the current
// FY shows a blend of exact figures (already-decided renewals) and a
// "Projected" estimate for subscriptions that haven't renewed yet — see
// get_team_spend() for the actual/projected split this renders.
export default function TeamSpendCard() {
  const maxFy = currentFiscalYear() + 1
  const [fy, setFy] = useState(currentFiscalYear())
  const [cache, setCache] = useState({})
  const [error, setError] = useState(null)

  useEffect(() => {
    if (cache[fy]) return
    getTeamSpend(fy)
      .then(data => setCache(c => ({ ...c, [fy]: data })))
      .catch(e => setError(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fy])

  const data = cache[fy]
  const projected = !!data && [data.suiteKey, data.ministry, data.gtis].some(c => c.projected > 0)
  const total = key => Math.round(data[key].actual + data[key].projected)

  return (
    <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
      <div className="flex items-center justify-center gap-4 pb-4 mb-4 border-b">
        <button
          onClick={() => setFy(f => f - 1)}
          aria-label="Previous fiscal year"
          className="w-8 h-8 flex-none flex items-center justify-center rounded-lg border border-gray-200 text-brand hover:bg-brand/5"
        >
          <ChevronLeft size={16} />
        </button>

        <div className="text-center min-w-[180px]">
          <div className="flex items-center justify-center gap-2">
            <h2 className="font-display font-bold text-lg text-brand">FY{fy}</h2>
            {projected && (
              <span className="text-[10px] font-bold uppercase tracking-wide text-sil-yellow bg-sil-yellow/10 rounded px-1.5 py-0.5">
                Projected
              </span>
            )}
          </div>
          <div className="text-xs text-gray-400 mt-0.5">{fyPeriod(fy)}</div>
        </div>

        <button
          onClick={() => setFy(f => Math.min(f + 1, maxFy))}
          disabled={fy >= maxFy}
          aria-label="Next fiscal year"
          className="w-8 h-8 flex-none flex items-center justify-center rounded-lg border border-gray-200 text-brand hover:bg-brand/5 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {error && <p className="text-sil-red text-sm">{error}</p>}
      {!data && !error && <p className="text-gray-400 text-sm text-center">Loading…</p>}

      {data && (
        <div className="grid grid-cols-3 gap-2.5">
          <div className="bg-brand/10 rounded-lg pt-4 pb-4 px-2 flex flex-col items-center gap-1 text-center">
            <div className="text-xs font-bold tracking-wide text-brand-dark">SUITEKEY</div>
            <div className="text-[28px] leading-none font-display font-bold text-brand-dark tabular-nums">{money(total('suiteKey'))}</div>
          </div>

          <div className="py-3.5 px-2 flex flex-col items-center gap-1 text-center">
            <div className="text-xs font-bold tracking-wide text-gray-500">MINISTRY ACCOUNTS</div>
            <div className="text-lg font-semibold text-gray-500 tabular-nums">{money(total('ministry'))}</div>
            <div className="text-[11px] text-gray-400 max-w-[15ch]">Summed across all Ministry IDs</div>
          </div>

          <div className="py-3.5 px-2 flex flex-col items-center gap-1 text-center">
            <a
              href="https://gtis.sil.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-bold tracking-wide text-gray-500 hover:text-brand inline-flex items-center gap-1 border-b border-dotted border-gray-300 hover:border-brand"
            >
              GTIS
              <ExternalLink size={10} />
            </a>
            <div className="text-lg font-semibold text-gray-500 tabular-nums">{money(total('gtis'))}</div>
            <div className="text-[11px] text-gray-400">Paid by GTIS</div>
          </div>
        </div>
      )}
    </div>
  )
}
