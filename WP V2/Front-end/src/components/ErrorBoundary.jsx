import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      message: error?.message || 'An unexpected error occurred.',
    };
  }

  handleReload = () => {
    window.location.reload();
  };

  handleGoHome = () => {
    window.location.href = '/';
  };

  render() {
    const { hasError, message } = this.state;
    const { children } = this.props;

    if (!hasError) {
      return children;
    }

    return (
      <div className="error-boundary-page">
        <div className="card error-boundary-card">
          <h2>Something went wrong</h2>
          <p className="muted-text">
            The application hit an unexpected error. You can reload the page or return to the dashboard.
          </p>
          {import.meta.env.DEV && message && (
            <pre className="error-boundary-details">{message}</pre>
          )}
          <div className="error-boundary-actions">
            <button type="button" className="btn btn-secondary" onClick={this.handleGoHome}>
              Go to dashboard
            </button>
            <button type="button" className="btn btn-save" onClick={this.handleReload}>
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
