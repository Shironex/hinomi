import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ErrorState } from './error-state'

interface Props {
  children: ReactNode
  /** Rendered instead of the default error panel. */
  fallback?: (error: unknown, reset: () => void) => ReactNode
}

interface State {
  error: unknown
  hasError: boolean
}

/** Last line of defense for render errors outside the router (the router has its own per route). */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, hasError: false }

  static getDerivedStateFromError(error: unknown): State {
    return { error, hasError: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Unhandled render error', error, info.componentStack)
  }

  reset = () => this.setState({ error: null, hasError: false })

  override render() {
    if (!this.state.hasError) return this.props.children
    if (this.props.fallback) return this.props.fallback(this.state.error, this.reset)
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorState title="Hinomi hit an error" error={this.state.error} onRetry={this.reset} />
      </div>
    )
  }
}
