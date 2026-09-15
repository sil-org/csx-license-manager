import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { getActiveAnnouncement } from '../lib/announcements'

// Keyed on id+updated_at (not just id) so re-saving/editing the live
// announcement makes it reappear even for people who dismissed the old text.
function dismissKey(a) {
  return `announcement-dismissed-${a.id}-${a.updated_at}`
}

export default function AnnouncementBanner() {
  const [announcement, setAnnouncement] = useState(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    getActiveAnnouncement().then(a => {
      if (cancelled || !a) return
      setDismissed(localStorage.getItem(dismissKey(a)) === '1')
      setAnnouncement(a)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (!announcement || dismissed) return null

  function dismiss() {
    localStorage.setItem(dismissKey(announcement), '1')
    setDismissed(true)
  }

  return (
    <div className="bg-brand text-white px-4 py-2.5 flex items-center gap-3 text-sm">
      <p className="flex-1">{announcement.message}</p>
      {announcement.cta_label && announcement.cta_url && (
        <a
          href={announcement.cta_url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline underline-offset-2 whitespace-nowrap flex-shrink-0"
        >
          {announcement.cta_label}
        </a>
      )}
      <button onClick={dismiss} aria-label="Dismiss" className="flex-shrink-0 hover:opacity-75">
        <X size={16} />
      </button>
    </div>
  )
}
