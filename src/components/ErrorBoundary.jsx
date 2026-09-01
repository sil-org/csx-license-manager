import { Component } from 'react'

export default class ErrorBoundary extends Component {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error) {
    console.error(error)
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="min-h-screen flex flex-col items-center justify-center text-center px-4">
        <p className="text-gray-600 mb-4 max-w-sm">
          Something went wrong. If your browser blocked a redirect during sign-in, allow redirects
          for sil.org and accounts.google.com, then reload.
        </p>
        <button onClick={() => window.location.assign('/')} className="text-brand underline text-sm">
          Reload
        </button>
      </div>
    )
  }
}
