// Shared by every admin CSV export (Audit Log, Finance Export, All
// Subscriptions) — each page supplies its own header + row arrays.
export function csvEscape(value) {
  const s = String(value ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function downloadCsv(header, rows, filename) {
  const lines = [header, ...rows]
  const csv = lines.map(line => line.map(csvEscape).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
