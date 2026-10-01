// SIL's fiscal year runs Oct 1 - Sep 30 and is named for the calendar year
// it ends in: Oct 1 2026 starts FY2027. Same rule as fy_boundary_months()
// (pending/70_team_spend.sql) and admin_import_subscriptions()'s default fy.

// Accepts a Date or a 'YYYY-MM-DD' string. Date-only strings are read as a
// local calendar date — `new Date('2026-10-01')` parses as UTC midnight,
// which is Sep 30 in US timezones and would land in the wrong FY.
export function fiscalYearOf(date) {
  const d = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
    : new Date(date)
  return d.getMonth() >= 9 ? d.getFullYear() + 1 : d.getFullYear()
}

export function currentFiscalYear() {
  return fiscalYearOf(new Date())
}
