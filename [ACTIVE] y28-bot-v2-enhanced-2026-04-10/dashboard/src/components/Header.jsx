import { useState, useEffect, useRef } from 'react';
import { Settings, Pause, Play } from 'lucide-react';
import { togglePause } from '../utils/api.js';
import ErrorBell from './ErrorBell.jsx';

const PRICE_CHIPS = [
  { asset: 'BTC', decimals: 2 },
  { asset: 'ETH', decimals: 2 },
  { asset: 'SOL', decimals: 2 },
  { asset: 'XRP', decimals: 4 },
];

function formatUptime(seconds) {
  if (seconds == null) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatPrice(price, decimals) {
  if (price == null) return '--';
  return Number(price).toFixed(decimals);
}

function PriceChip({ asset, decimals, price, prevPrice }) {
  const [arrow, setArrow] = useState(null);
  const [fading, setFading] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (prevPrice == null || price == null || prevPrice === price) return;

    const dir = price > prevPrice ? 'up' : 'down';
    setArrow(dir);
    setFading(false);

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setFading(true);
      setTimeout(() => setArrow(null), 400);
    }, 1600);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [price, prevPrice]);

  return (
    <div
      className="flex items-center"
      style={{
        background: '#1A1A1A',
        borderRadius: 6,
        padding: '6px 12px',
        gap: 6,
      }}
    >
      <span style={{ color: '#888888', fontSize: 12, fontWeight: 600 }}>{asset}</span>
      <span className="text-white" style={{ fontSize: 13 }}>
        {formatPrice(price, decimals)}
      </span>
      {arrow && (
        <span
          style={{
            fontSize: 8,
            color: '#888888',
            transition: 'opacity 0.4s ease',
            opacity: fading ? 0 : 0.7,
            marginLeft: 2,
          }}
        >
          {arrow === 'up' ? '\u25B2' : '\u25BC'}
        </span>
      )}
    </div>
  );
}

function PauseModal({ onClose, onSuccess }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await togglePause(password);
      onSuccess(result.paused);
      onClose();
    } catch (err) {
      if (err.response?.status === 401) {
        setError('Wrong password');
      } else {
        setError('Request failed');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg p-6 w-full max-w-xs font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-textPrimary text-sm mb-4">Enter password to confirm</p>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-textPrimary font-mono placeholder-textSecondary focus:outline-none focus:border-green mb-3"
            autoFocus
          />
          {error && <p className="text-red text-xs mb-3">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-bg border border-border text-textSecondary text-sm py-2 rounded hover:opacity-80"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !password}
              className="flex-1 bg-green text-bg text-sm py-2 rounded hover:opacity-90 disabled:opacity-50"
            >
              {loading ? '...' : 'Confirm'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Header({ status, errorCount, onErrorOpen, onSettingsOpen }) {
  const prices = status?.prices || {};
  const pool = status?.pool;
  const uptime = status?.uptime;
  const dryRun = status?.dryRun;
  const botPaused = status?.paused || false;

  const [showPauseModal, setShowPauseModal] = useState(false);

  // Track previous prices to detect changes
  const prevPricesRef = useRef({});
  const [prevPrices, setPrevPrices] = useState({});

  useEffect(() => {
    // Only update prevPrices when prices actually change
    const current = prevPricesRef.current;
    const changed = PRICE_CHIPS.some(({ asset }) => prices[asset] !== current[asset]);
    if (changed) {
      setPrevPrices({ ...current });
      prevPricesRef.current = { ...prices };
    }
  }, [prices]);

  return (
    <div
      className="w-full header-wrap font-mono"
      style={{
        background: '#0A0A0A',
        border: '1px solid #1A1A1A',
        borderRadius: 12,
        padding: '16px 24px',
        marginTop: 12,
      }}
    >
      {/* Left — Logo + badges */}
      <div className="flex flex-col">
        <img src="/logo.png" alt="y28 PMB" style={{ height: 32 }} />
        <div className="flex gap-2 mt-1">
          {dryRun && (
            <span
              className="text-xs font-bold self-start"
              style={{
                background: 'rgba(245, 158, 11, 0.15)',
                color: '#F59E0B',
                padding: '2px 8px',
                borderRadius: 9999,
              }}
            >
              DRY RUN
            </span>
          )}
          {botPaused && (
            <span
              className="text-xs font-bold self-start"
              style={{
                background: 'rgba(255, 59, 59, 0.15)',
                color: '#FF3B3B',
                padding: '2px 8px',
                borderRadius: 9999,
                animation: 'pulse-badge 2s ease-in-out infinite',
              }}
            >
              PAUSED
            </span>
          )}
        </div>
      </div>

      {/* Center — Price chips */}
      <div className="header-prices">
        {PRICE_CHIPS.map(({ asset, decimals }) => (
          <PriceChip
            key={asset}
            asset={asset}
            decimals={decimals}
            price={prices[asset]}
            prevPrice={prevPrices[asset]}
          />
        ))}
      </div>

      {/* Right — Pool balance, pause, uptime, error bell, settings */}
      <div className="header-right">
        <span className="text-white text-lg font-bold">
          ${pool != null ? Number(pool).toFixed(2) : '--'}
        </span>
        <button
          onClick={() => setShowPauseModal(true)}
          style={{
            background: botPaused ? '#00D341' : '#FFB800',
            border: 'none',
            cursor: 'pointer',
            padding: '4px 10px',
            borderRadius: 9999,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            fontWeight: 700,
            fontFamily: 'JetBrains Mono, monospace',
            color: '#0C0C0C',
          }}
        >
          {botPaused ? <Play size={14} /> : <Pause size={14} />}
          {botPaused ? 'RESUME' : 'PAUSE'}
        </button>
        <span className="text-textSecondary text-sm">
          {formatUptime(uptime)}
        </span>
        <ErrorBell errorCount={errorCount} onOpen={onErrorOpen} />
        <button
          onClick={onSettingsOpen}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex' }}
        >
          <Settings size={20} color="#888" />
        </button>
      </div>

      {showPauseModal && (
        <PauseModal
          onClose={() => setShowPauseModal(false)}
          onSuccess={() => {}}
        />
      )}

      <style>{`
        @keyframes pulse-badge {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .header-wrap {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .header-prices {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .header-right {
          display: flex;
          align-items: center;
          gap: 16px;
        }
        @media (max-width: 640px) {
          .header-wrap {
            flex-wrap: wrap;
            gap: 12px;
            padding: 12px 16px !important;
          }
          .header-prices {
            order: 3;
            width: 100%;
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
            padding-bottom: 4px;
            gap: 6px;
          }
          .header-right {
            gap: 10px;
            flex-wrap: wrap;
          }
          .header-right > span.text-white {
            font-size: 15px;
          }
        }
      `}</style>
    </div>
  );
}
