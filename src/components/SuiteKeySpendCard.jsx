import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { getSuiteKeySpend } from '../lib/suiteKeyCharges'

// FY runs Oct 1 - Sep 30 — see TeamSpendCard.jsx, which uses the same rule.
function currentFiscalYear() {
  const now = new Date()
  return now.getMonth() + 1 >= 10 ? now.getFullYear() + 1 : now.getFullYear()
}

function fyPeriod(fy) {
  return `Oct 1, ${fy - 1} – Sep 30, ${fy}`
}

const money = n => '$' + Math.round(n).toLocaleString('en-US')

// Sits at the top of SuiteKey Charges: one tile per SuiteKey the caller
// owns, for one fiscal year, with the same FY-switcher/projection behavior
// as TeamSpendCard — no single key is emphasized here (unlike My Team's
// SuiteKey-vs-Ministry-vs-GTIS split, these are all peers), and the tile
// row wraps to fit however many keys someone owns instead of assuming a
// fixed count.
export default function SuiteKeySpendCard() {
  const maxFy = currentFiscalYear() + 1
  const [fy, setFy] = useState(currentFiscalYear())
  const [cache, setCache] = useState({})
  const [error, setError] = useState(null)

  useEffect(() => {
    if (cache[fy]) return
    getSuiteKeySpend(fy)
      .then(rows => setCache(c => ({ ...c, [fy]: rows })))
      .catch(e => setError(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fy])

  const rows = cache[fy]
  const projected = !!rows && rows.some(r => r.projected > 0)

  // No SuiteKeys owned at all — the page itself already explains that below.
  if (rows && rows.length === 0) return null

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
      {!rows && !error && <p className="text-gray-400 text-sm text-center">Loading…</p>}

      {rows && rows.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-2.5">
          {rows.map(r => (
            <div key={r.suite_key} className="bg-gray-50 border border-gray-100 rounded-lg py-3.5 px-2 flex flex-col items-center gap-1 text-center">
              <div className="text-xs font-bold tracking-wide text-brand truncate max-w-full" title={r.suite_key}>{r.suite_key}</div>
              <div className="text-lg font-semibold text-gray-700 tabular-nums">{money(r.actual + r.projected)}</div>
            </div>
          ))}
        </div>
      )}

      {projected && (
        <p className="text-xs text-gray-400 border border-dashed border-gray-200 rounded-lg px-3.5 py-2.5 mt-4">
          <span className="font-semibold text-gray-500">Projected</span> — some subscriptions here haven't
          renewed for FY{fy} yet. Their share of this total is estimated at current price + 10%,
          pro-rated to the fiscal year, alongside the exact pro-rated tail of renewals already decided.
        </p>
      )}
    </div>
  )
}
