import React from 'react';
import PhotoBooth from './PhotoBooth';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="page" style={{ justifyContent: 'center' }}>
          <div className="card" style={{ textAlign: 'center' }}>
            <p style={{ fontSize: 36, marginBottom: 16 }}>!</p>
            <h2 className="title">Something went wrong</h2>
            <p className="subtitle">{this.state.error?.message || 'An unexpected error occurred'}</p>
            <button className="btn-primary" onClick={() => this.setState({ hasError: false, error: null })}>
              Restart App
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <PhotoBooth />
    </ErrorBoundary>
  );
}
