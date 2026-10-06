import { useState } from 'react'
import { MessageSquarePlus, Bug, Lightbulb, MessageCircle, X, Check } from 'lucide-react'

const TYPES = [
  { id: 'bug', label: 'Bug', Icon: Bug, placeholder: "What happened, and what did you expect instead?", githubLabel: 'bug' },
  { id: 'feature', label: 'Feature', Icon: Lightbulb, placeholder: 'What would you like to be able to do?', githubLabel: 'enhancement' },
  { id: 'comment', label: 'Comment', Icon: MessageCircle, placeholder: "What's on your mind?", githubLabel: 'comment' },
]

// Floating feedback trigger — bottom-right blue button. `onSubmit` does the
// actual delivery (files a GitHub issue); this component only owns the
// type/title/description UI and the open/submitting/done/error states.
export default function FeedbackWidget({ onSubmit }) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState('idle') // idle | submitting | done | error

  const activeType = TYPES.find(t => t.id === type)

  function close() {
    setOpen(false)
    // small delay so the modal doesn't visibly reset while closing
    setTimeout(() => {
      setType('bug')
      setTitle('')
      setDescription('')
      setStatus('idle')
    }, 200)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!title.trim() || !description.trim()) return

    setStatus('submitting')
    try {
      await onSubmit({
        type,
        githubLabel: activeType.githubLabel,
        title: title.trim(),
        description: description.trim(),
      })
      setStatus('done')
    } catch {
      setStatus('error')
    }
  }

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 sm:items-center"
          onClick={close}
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl border border-gray-200"
          >
            {status === 'done' ? (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-sil-green/10">
                  <Check size={24} className="text-sil-green" />
                </div>
                <p className="text-base font-medium text-gray-800">Thanks — we got it.</p>
                <p className="text-sm text-gray-500">Your {activeType.label.toLowerCase()} has been logged with the team.</p>
                <button
                  onClick={close}
                  className="mt-2 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                >
                  Close
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit}>
                <div className="mb-4 flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-800">Send feedback</p>
                  <button type="button" onClick={close} className="text-gray-400 hover:text-gray-600" aria-label="Close">
                    <X size={16} />
                  </button>
                </div>

                <div className="mb-4 grid grid-cols-3 gap-2">
                  {TYPES.map(t => {
                    const active = t.id === type
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setType(t.id)}
                        className={`flex flex-col items-center gap-1.5 rounded-md border px-2 py-3 text-xs font-medium transition-colors ${
                          active ? 'border-brand bg-brand text-white' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        <t.Icon size={18} />
                        {t.label}
                      </button>
                    )
                  })}
                </div>

                <label className="mb-1 block text-xs font-medium text-gray-500">Title</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Short summary"
                  maxLength={120}
                  className="mb-3 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-hidden"
                />

                <label className="mb-1 block text-xs font-medium text-gray-500">Details</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={activeType.placeholder}
                  rows={3}
                  className="mb-3 w-full resize-none rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-hidden"
                />

                {status === 'error' && (
                  <p className="mb-2 text-xs text-sil-red">Couldn't send that — try again?</p>
                )}

                <button
                  type="submit"
                  disabled={status === 'submitting' || !title.trim() || !description.trim()}
                  className="w-full bg-brand text-white text-sm font-medium rounded-md px-4 py-2 hover:opacity-90 disabled:opacity-40"
                >
                  {status === 'submitting' ? 'Sending…' : 'Send feedback'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen(o => !o)}
        className="fixed bottom-5 right-5 z-40 bg-brand text-white rounded-full p-3.5 shadow-lg hover:opacity-90 transition"
        aria-label="Send feedback"
      >
        <MessageSquarePlus size={20} />
      </button>
    </>
  )
}
