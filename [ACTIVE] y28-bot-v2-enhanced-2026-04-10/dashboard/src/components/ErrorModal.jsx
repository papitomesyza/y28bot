import { X } from 'lucide-react';

function formatTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export default function ErrorModal({ errors, isOpen, onClose }) {
  if (!isOpen) return null;

  function handleCopyAll() {
    const text = errors.map((e) => `[${formatTs(e.timestamp)}] ${e.message}`).join('\n');
    navigator.clipboard.writeText(text).catch(() => {});
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#0A0A0A',
          border: '1px solid #1A1A1A',
          borderRadius: 8,
          width: '100%',
          maxWidth: 700,
          maxHeight: '70vh',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid #1A1A1A',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: '#FF3B3B', fontSize: 14, fontWeight: 700 }}>
              Runtime Errors
            </span>
            <span style={{ color: '#888', fontSize: 12 }}>
              {errors.length} {errors.length === 1 ? 'error' : 'errors'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={handleCopyAll}
              style={{
                background: 'none',
                border: '1px solid #00D341',
                color: '#00D341',
                borderRadius: 4,
                padding: '4px 12px',
                fontSize: 11,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Copy All Errors
            </button>
            <button
              onClick={onClose}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              <X size={18} color="#888" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', padding: '12px 20px', flex: 1 }}>
          {errors.length === 0 ? (
            <p style={{ color: '#888', fontSize: 13, textAlign: 'center', padding: 24 }}>
              No errors recorded.
            </p>
          ) : (
            errors.map((err, i) => (
              <div
                key={i}
                style={{
                  padding: '8px 0',
                  borderBottom: i < errors.length - 1 ? '1px solid #1A1A1A' : 'none',
                }}
              >
                <span style={{ color: '#888', fontSize: 11, marginRight: 10 }}>
                  {formatTs(err.timestamp)}
                </span>
                <span style={{ color: '#FF3B3B', fontSize: 12 }}>{err.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
