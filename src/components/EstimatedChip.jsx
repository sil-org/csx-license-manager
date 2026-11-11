// "Est." marker for a spend total that leans on a fallback price: legacy
// subscriptions imported with no recorded price_at_signup are estimated at the
// license's current price. `count` comes from estimated_count on
// get_suite_key_spend() / get_team_spend(); an older function omits it, so
// this renders nothing until those migrations (87/88) are applied.
export default function EstimatedChip({ count }) {
  if (!(count > 0)) return null
  return (
    <span
      title={`Includes ${count} subscription${count === 1 ? '' : 's'} with no recorded price, estimated at the license's current price`}
      className="text-[10px] font-bold uppercase tracking-wide text-sil-yellow bg-sil-yellow/10 rounded-sm px-1.5 py-0.5"
    >
      Est.
    </span>
  )
}

export function EstimatedNote() {
  return (
    <p className="text-xs text-gray-400 border border-dashed border-gray-200 rounded-lg px-3.5 py-2.5 mt-4">
      <span className="font-semibold text-gray-500">Est.</span> — some subscriptions here (mostly imported from
      the old system) have no recorded price. Their share of the total is estimated at the license's current
      price, so it may differ from what was actually charged.
    </p>
  )
}
