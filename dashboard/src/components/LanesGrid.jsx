import { ChevronUp, ChevronDown } from 'lucide-react';

function getIrrevColor(irrev) {
  if (irrev >= 1.7) return '#00D341';
  if (irrev >= 1.0) return '#FFB800';
  return '#888888';
}

function formatRemaining(seconds) {
  if (seconds == null) return '--';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatDelta(current, open) {
  if (current == null || open == null || open === 0) return null;
  const delta = ((current - open) / open) * 100;
  const sign = delta >= 0 ? '+' : '';
  return { text: `${sign}${delta.toFixed(2)}%`, positive: delta >= 0 };
}

function getDecimals(asset) {
  if (asset === 'XRP') return 4;
  if (asset === 'SOL') return 2;
  return 2;
}

function LaneCard({ lane }) {
  const {
    id,
    asset,
    currentPrice,
    openPrice,
    irrev = 0,
    direction,
    remainingSeconds,
    stackLevel = 0,
  } = lane;

  const irrevColor = getIrrevColor(irrev);
  const irrevWidth = Math.min((irrev / 3.0) * 100, 100);
  const delta = formatDelta(currentPrice, openPrice);
  const decimals = getDecimals(asset);
  const isUp = direction === 'UP';

  const bgGradient = isUp
    ? 'linear-gradient(135deg, rgba(0,211,65,0.08) 0%, transparent 60%)'
    : direction === 'DOWN'
      ? 'linear-gradient(135deg, rgba(255,59,59,0.08) 0%, transparent 60%)'
      : 'none';

  return (
    <div
      className="lane-card"
      style={{
        background: bgGradient,
        backgroundColor: '#0A0A0A',
        border: '1px solid #1A1A1A',
        borderLeft: `3px solid ${irrevColor}`,
        borderRadius: 8,
        padding: '10px 14px',
        fontFamily: '"JetBrains Mono", monospace',
        minWidth: 0,
      }}
    >
      {/* Top row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ color: '#FFFFFF', fontWeight: 700, fontSize: 13 }}>{id}</span>
        {direction && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            {isUp ? (
              <ChevronUp size={14} color="#00D341" strokeWidth={2.5} />
            ) : (
              <ChevronDown size={14} color="#FF3B3B" strokeWidth={2.5} />
            )}
            <span
              style={{
                color: isUp ? '#00D341' : '#FF3B3B',
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {direction}
            </span>
          </div>
        )}
      </div>

      {/* Irrev bar */}
      <div style={{ marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              flex: 1,
              height: 6,
              backgroundColor: '#1A1A1A',
              borderRadius: 4,
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <div
              style={{
                width: `${irrevWidth}%`,
                height: '100%',
                backgroundColor: irrevColor,
                borderRadius: 4,
                transition: 'width 0.4s ease, background-color 0.4s ease',
              }}
            />
          </div>
          <span
            style={{
              color: irrevColor,
              fontSize: 11,
              fontWeight: 600,
              minWidth: 32,
              textAlign: 'right',
            }}
          >
            {irrev.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Bottom row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: '#888888', fontSize: 11 }}>
          {formatRemaining(remainingSeconds)}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
          <span style={{ color: '#FFFFFF' }}>
            {currentPrice != null ? Number(currentPrice).toFixed(decimals) : '--'}
          </span>
          {delta && (
            <span style={{ color: delta.positive ? '#00D341' : '#FF3B3B', fontSize: 10 }}>
              ({delta.text})
            </span>
          )}
        </div>
      </div>

      {/* Stack dots */}
      {stackLevel > 0 && (
        <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
          {Array.from({ length: stackLevel }, (_, i) => (
            <div
              key={i}
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                backgroundColor: '#00D341',
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function LanesGrid({ status }) {
  const lanes = status?.lanes || [];

  if (lanes.length === 0) {
    return (
      <div
        style={{
          background: '#0A0A0A',
          border: '1px solid #1A1A1A',
          borderRadius: 8,
          padding: 16,
        }}
      >
        <span style={{ color: '#888888', fontSize: 14 }}>No lane data</span>
      </div>
    );
  }

  return (
    <>
      <style>{`
        .lanes-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 12px;
        }
        @media (max-width: 768px) {
          .lanes-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }
        @media (max-width: 640px) {
          .lanes-grid {
            grid-template-columns: repeat(2, 1fr);
            gap: 8px;
            overflow: hidden;
          }
          .lane-card {
            padding: 8px 10px !important;
          }
        }
      `}</style>
      <div className="lanes-grid">
        {lanes.map((lane) => (
          <LaneCard key={lane.id} lane={lane} />
        ))}
      </div>
    </>
  );
}
