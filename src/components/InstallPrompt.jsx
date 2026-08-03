import { useEffect, useState } from 'react'
import { Download, Share, X } from 'lucide-react'

const DISMISS_KEY = 'pwa-install-dismissed-at'
const DISMISS_DAYS = 30

function isDismissed() {
  const raw = localStorage.getItem(DISMISS_KEY)
  if (!raw) return false
  const days = (Date.now() - Number(raw)) / (1000 * 60 * 60 * 24)
  return days < DISMISS_DAYS
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
}

// iPadOS 13+ reports as "MacIntel" in the UA string but has touch support,
// unlike a real Mac — that's the standard sniff to tell them apart.
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

// Bottom install banner, rendered app-wide from AppLayout so every
// downstream app gets it for free. Two cases, because the platforms don't
// give equivalent signals:
//   - Chrome/Edge/Android: fires `beforeinstallprompt`, so we can show a
//     real "Install" button that triggers the native prompt.
//   - iOS Safari: never fires that event and has no programmatic install
//     API at all — the only thing that works is telling the user to use
//     Share > Add to Home Screen themselves.
// Both are skipped entirely once the app is already running standalone.
export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [showIOSInstructions, setShowIOSInstructions] = useState(false)
  const [dismissed, setDismissed] = useState(true)

  useEffect(() => {
    if (isStandalone() || isDismissed()) return
    setDismissed(false)

    if (isIOS()) {
      setShowIOSInstructions(true)
      return
    }

    function onBeforeInstallPrompt(e) {
      e.preventDefault()
      setDeferredPrompt(e)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  }, [])

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
    setDismissed(true)
  }

  async function handleInstall() {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    await deferredPrompt.userChoice
    setDeferredPrompt(null)
    dismiss()
  }

  if (dismissed || (!deferredPrompt && !showIOSInstructions)) return null

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-2rem)] max-w-sm bg-white rounded-xl shadow-lg border border-gray-200 p-4 flex items-start gap-3">
      {showIOSInstructions ? (
        <>
          <Share size={20} className="text-brand flex-shrink-0 mt-0.5" />
          <p className="text-sm text-gray-700 flex-1">
            Install this app: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
          </p>
        </>
      ) : (
        <>
          <Download size={20} className="text-brand flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm text-gray-700 mb-2">Install this app for quicker access.</p>
            <button onClick={handleInstall} className="text-sm font-medium bg-brand text-white rounded-lg px-3 py-1.5">
              Install
            </button>
          </div>
        </>
      )}
      <button onClick={dismiss} className="text-gray-400 hover:text-gray-600 flex-shrink-0" aria-label="Dismiss">
        <X size={16} />
      </button>
    </div>
  )
}
