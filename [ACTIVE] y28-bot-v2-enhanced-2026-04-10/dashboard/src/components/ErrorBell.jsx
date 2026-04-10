import { Bell } from 'lucide-react';

export default function ErrorBell({ errorCount, onOpen }) {
  return (
    <button
      onClick={onOpen}
      className="relative"
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
    >
      <Bell size={20} color="#888" />
      {errorCount > 0 && (
        <span
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            background: '#FF3B3B',
            color: '#fff',
            fontSize: 10,
            fontFamily: 'JetBrains Mono, monospace',
            lineHeight: '16px',
            minWidth: 16,
            height: 16,
            borderRadius: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 4px',
          }}
        >
          {errorCount}
        </span>
      )}
    </button>
  );
}
