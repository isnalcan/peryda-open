import { Component, type ReactNode } from 'react'

interface Props {
  title: string
  action: string
  onReset: () => void
  children: ReactNode
}

/** Keeps one failing screen from blanking the whole app. */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="error-screen" role="alert">
        <p>{this.props.title}</p>
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            this.setState({ failed: false })
            this.props.onReset()
          }}
        >
          {this.props.action}
        </button>
      </div>
    )
  }
}
