import { useState, useEffect, useRef } from 'react';
import { ChevronUp, ChevronDown, ExternalLink, Bookmark, Settings } from 'lucide-react';
import { fetchTrades, fetchPositions, claimAll, toggleBookmark, updateTradeResult } from '../utils/api.js';

const RESULT_FILTERS = ['All', 'Won', 'Lost', 'Pending', 'Expired', 'Burned'];
const PAGE_SIZE = 20;

function parseDate(raw) {
  if (!raw) return null;
  let d = new Date(raw);
  if (isNaN(d.getTime())) {
    // SQLite CURRENT_TIMESTAMP produces "YYYY-MM-DD HH:MM:SS" without timezone — treat as UTC
    d = new Date(raw + 'Z');
  }
  return isNaN(d.getTime()) ? null : d;
}

function formatTime(ts) {
  const d = parseDate(ts);
  if (!d) return '--';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDate(ts) {
  const d = parseDate(ts);
  if (!d) return '--';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function formatDollar(v) {
  const n = Number(v);
  if (isNaN(n)) return '$0.00';
  return '$' + Math.abs(n).toFixed(2);
}

function PnlCell({ value }) {
  const n = Number(value) || 0;
  const pillBase = { display: 'inline-block', padding: '1px 6px', borderRadius: 4, fontSize: 12, fontWeight: 500 };
  if (n > 0) return <span style={{ ...pillBase, background: 'rgba(0,211,65,0.12)', color: '#00D341' }}>+{formatDollar(n)}</span>;
  if (n < 0) return <span style={{ ...pillBase, background: 'rgba(255,59,59,0.12)', color: '#FF3B3B' }}>-{formatDollar(n)}</span>;
  return <span style={{ color: '#555' }}>$0.00</span>;
}

function ResultBadge({ result }) {
  const styles = {
    won: { background: 'rgba(0,211,65,0.15)', color: '#00D341', borderLeft: '3px solid #00D341', paddingLeft: 8 },
    lost: { background: 'rgba(255,59,59,0.15)', color: '#FF3B3B', borderLeft: '3px solid #FF3B3B', paddingLeft: 8 },
    pending: { background: 'rgba(255,184,0,0.15)', color: '#FFB800', borderLeft: '3px solid #FFB800', paddingLeft: 8 },
    expired: { background: 'rgba(136,136,136,0.15)', color: '#888', borderLeft: '3px solid #555', paddingLeft: 8 },
    burned: { background: 'rgba(136,136,136,0.15)', color: '#888', borderLeft: '3px solid #555', paddingLeft: 8 },
  };
  const s = styles[result] || styles.pending;
  return (
    <span
      className="px-2 py-1 rounded text-xs font-mono capitalize font-semibold"
      style={s}
    >
      {result}
    </span>
  );
}

function ExportPanel({ trades }) {
  const [open, setOpen] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [statusFilters, setStatusFilters] = useState({ won: true, lost: true, pending: true, expired: true, burned: true });
  const panelRef = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  function getFilteredTrades() {
    return trades.filter((t) => {
      const result = t.result || 'pending';
      if (!statusFilters[result]) return false;
      if (fromDate || toDate) {
        const d = parseDate(t.created_at);
        if (!d) return false;
        if (fromDate && d < new Date(fromDate)) return false;
        if (toDate) {
          const end = new Date(toDate);
          end.setDate(end.getDate() + 1);
          if (d >= end) return false;
        }
      }
      return true;
    });
  }

  function tradeToRow(t) {
    const d = parseDate(t.created_at);
    const time = d ? d.toISOString().replace('T', ' ').slice(0, 19) : '--';
    const result = t.result || 'pending';
    const shares = Math.round(Number(t.shares) || 0);
    const pnl = Number(t.pnl) || 0;
    const pnlStr = pnl >= 0 ? `+$${Math.abs(pnl).toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const payout = result === 'won' ? `$${shares.toFixed(2)}` : result === 'lost' || result === 'burned' ? '$0.00' : '--';
    return {
      time,
      lane: t.lane_id || '--',
      side: t.side || '--',
      entry: `$${Number(t.entry_price || 0).toFixed(2)}`,
      cost: `$${Number(t.cost || 0).toFixed(2)}`,
      shares,
      irrev: Number(t.irrev || 0).toFixed(2),
      payout,
      pnl: pnlStr,
      result,
    };
  }

  function handleCopyText() {
    const rows = getFilteredTrades().map(tradeToRow);
    const header = 'Time\tLane\tSide\tEntry\tCost\tShares\tIrrev\tPayout\tP&L\tResult';
    const lines = rows.map((r) => `${r.time}\t${r.lane}\t${r.side}\t${r.entry}\t${r.cost}\t${r.shares}\t${r.irrev}\t${r.payout}\t${r.pnl}\t${r.result}`);
    navigator.clipboard.writeText([header, ...lines].join('\n')).catch(() => {});
    setOpen(false);
  }

  function handleExportCSV() {
    const rows = getFilteredTrades().map(tradeToRow);
    const header = 'Time,Lane,Side,Entry,Cost,Shares,Irrev,Payout,P&L,Result';
    const lines = rows.map((r) => `${r.time},${r.lane},${r.side},${r.entry},${r.cost},${r.shares},${r.irrev},${r.payout},${r.pnl},${r.result}`);
    const csv = [header, ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trades_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setOpen(false);
  }

  function toggleStatus(key) {
    setStatusFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <div ref={panelRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        className="px-2.5 py-1 rounded text-xs font-mono"
        style={{
          background: open ? '#1A1A1A' : 'transparent',
          color: '#888888',
          border: '1px solid #1A1A1A',
        }}
      >
        Export ▾
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            marginTop: 4,
            background: '#0E0E0E',
            border: '1px solid #1A1A1A',
            borderRadius: 8,
            padding: 14,
            zIndex: 50,
            width: 280,
            fontFamily: '"JetBrains Mono", monospace',
          }}
        >
          {/* Date range */}
          <div style={{ marginBottom: 10 }}>
            <span style={{ color: '#888', fontSize: 11, display: 'block', marginBottom: 4 }}>Date Range</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                style={{
                  flex: 1,
                  background: '#1A1A1A',
                  border: '1px solid #2A2A2A',
                  borderRadius: 4,
                  color: '#FFF',
                  padding: '4px 6px',
                  fontSize: 11,
                  fontFamily: '"JetBrains Mono", monospace',
                }}
              />
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                style={{
                  flex: 1,
                  background: '#1A1A1A',
                  border: '1px solid #2A2A2A',
                  borderRadius: 4,
                  color: '#FFF',
                  padding: '4px 6px',
                  fontSize: 11,
                  fontFamily: '"JetBrains Mono", monospace',
                }}
              />
            </div>
          </div>

          {/* Status filters */}
          <div style={{ marginBottom: 10 }}>
            <span style={{ color: '#888', fontSize: 11, display: 'block', marginBottom: 4 }}>Status</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {['won', 'lost', 'pending', 'expired', 'burned'].map((s) => (
                <label
                  key={s}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    color: statusFilters[s] ? '#FFF' : '#555',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={statusFilters[s]}
                    onChange={() => toggleStatus(s)}
                    style={{ accentColor: '#00D341', width: 12, height: 12 }}
                  />
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </label>
              ))}
            </div>
          </div>

          {/* Export buttons */}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={handleCopyText}
              className="text-xs font-mono"
              style={{
                flex: 1,
                background: '#1A1A1A',
                color: '#FFF',
                border: '1px solid #2A2A2A',
                borderRadius: 4,
                padding: '6px 0',
                cursor: 'pointer',
              }}
            >
              Copy as Text
            </button>
            <button
              onClick={handleExportCSV}
              className="text-xs font-mono"
              style={{
                flex: 1,
                background: '#00D341',
                color: '#0C0C0C',
                border: 'none',
                borderRadius: 4,
                padding: '6px 0',
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Export CSV
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TradeActionMenu({ tradeId, onAction }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  async function handleAction(action) {
    if (action === 'delete' && !window.confirm(`Delete trade #${tradeId}? This cannot be undone.`)) return;
    setOpen(false);
    try {
      await updateTradeResult(tradeId, action);
      onAction();
    } catch (err) {
      console.error('Trade action failed:', err);
    }
  }

  return (
    <div ref={menuRef} style={{ position: 'relative', display: 'inline-block' }}>
      <Settings
        size={14}
        style={{ cursor: 'pointer', color: open ? '#FFF' : '#555', transition: 'color 150ms' }}
        onClick={() => setOpen(!open)}
        onMouseEnter={(e) => { e.currentTarget.style.color = '#888'; }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.color = '#555'; }}
      />
      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            marginTop: 4,
            background: '#0E0E0E',
            border: '1px solid #1A1A1A',
            borderRadius: 6,
            padding: 4,
            zIndex: 50,
            width: 110,
            fontFamily: '"JetBrains Mono", monospace',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <button
            onClick={() => handleAction('win')}
            style={{
              background: 'transparent',
              color: '#00D341',
              border: 'none',
              borderRadius: 4,
              padding: '5px 8px',
              fontSize: 11,
              textAlign: 'left',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,211,65,0.1)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            Mark Won
          </button>
          <button
            onClick={() => handleAction('loss')}
            style={{
              background: 'transparent',
              color: '#FF3B3B',
              border: 'none',
              borderRadius: 4,
              padding: '5px 8px',
              fontSize: 11,
              textAlign: 'left',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,59,59,0.1)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            Mark Lost
          </button>
          <div style={{ height: 1, background: '#1A1A1A', margin: '2px 0' }} />
          <button
            onClick={() => handleAction('delete')}
            style={{
              background: 'transparent',
              color: '#888',
              border: 'none',
              borderRadius: 4,
              padding: '5px 8px',
              fontSize: 11,
              textAlign: 'left',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(136,136,136,0.1)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

export default function TradesTable() {
  const [trades, setTrades] = useState([]);
  const [filter, setFilter] = useState('All');
  const [page, setPage] = useState(1);
  const [redeemableCount, setRedeemableCount] = useState(0);
  const [claimAllLoading, setClaimAllLoading] = useState(false);
  const [claimAllResult, setClaimAllResult] = useState(null);
  const intervalRef = useRef(null);

  function loadTrades() {
    fetchTrades({ limit: 100 }).then(setTrades).catch(() => {});
  }

  function checkRedeemable() {
    fetchPositions()
      .then((data) => {
        const positions = Array.isArray(data.positions) ? data.positions : [];
        const redeemable = positions.filter((p) =>
          parseFloat(p.curPrice) === 1 && parseFloat(p.size) > 0 && (p.redeemable === true || p.redeemable === 'true')
        );
        setRedeemableCount(redeemable.length);
      })
      .catch(() => setRedeemableCount(0));
  }

  async function handleClaimAll() {
    setClaimAllLoading(true);
    setClaimAllResult(null);
    try {
      const result = await claimAll();
      setClaimAllResult(result);
      loadTrades();
      checkRedeemable();
    } catch (err) {
      setClaimAllResult({ claimed: [], failed: [{ title: 'error', error: err.message }] });
    } finally {
      setClaimAllLoading(false);
    }
  }

  async function handleBookmark(tradeId, isCurrentlyBookmarked) {
    const newState = !isCurrentlyBookmarked;
    try {
      await toggleBookmark(tradeId, newState);
      setTrades((prev) =>
        prev.map((t) => ({
          ...t,
          bookmarked: newState ? (t.id === tradeId ? 1 : 0) : (t.id === tradeId ? 0 : t.bookmarked),
        }))
      );
    } catch (_) {}
  }

  useEffect(() => {
    loadTrades();
    checkRedeemable();
    intervalRef.current = setInterval(() => {
      loadTrades();
      checkRedeemable();
    }, 60000);
    return () => clearInterval(intervalRef.current);
  }, []);

  // Reset page when filter changes
  useEffect(() => { setPage(1); }, [filter]);

  const filtered = filter === 'All'
    ? trades
    : trades.filter((t) => t.result === filter.toLowerCase());

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginated = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Generate page numbers
  function getPageNumbers() {
    const pages = [];
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= currentPage - 1 && i <= currentPage + 1)) {
        pages.push(i);
      } else if (pages[pages.length - 1] !== '...') {
        pages.push('...');
      }
    }
    return pages;
  }

  return (
    <div className="bg-card border border-border rounded-lg">
      {/* Header */}
      <div className="trades-header px-4 sm:px-5 py-3 border-b border-border flex items-center justify-between flex-wrap gap-2">
        <span className="text-textPrimary text-sm font-mono font-bold">Recent Trades</span>
        <div className="trades-header-right flex items-center gap-2 sm:gap-3">
          <div className="trades-filters flex gap-1">
            {RESULT_FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className="px-2 sm:px-2.5 py-1 rounded-full text-xs font-mono transition-colors whitespace-nowrap"
                style={{
                  background: filter === f ? '#00D341' : 'transparent',
                  color: filter === f ? '#0C0C0C' : '#888888',
                  border: filter === f ? 'none' : '1px solid #1A1A1A',
                }}
              >
                {f}
              </button>
            ))}
          </div>
          <ExportPanel trades={trades} />
          <button
            onClick={handleClaimAll}
            disabled={claimAllLoading || redeemableCount === 0}
            className={`${redeemableCount > 0 ? 'claim-btn' : ''} px-3 py-1 rounded text-xs font-mono font-semibold disabled:opacity-50`}
            style={{
              background: redeemableCount > 0 ? '#00D341' : '#1A1A1A',
              color: redeemableCount > 0 ? '#0C0C0C' : '#555',
              border: redeemableCount > 0 ? 'none' : '1px solid #1A1A1A',
              cursor: redeemableCount > 0 ? 'pointer' : 'default',
            }}
          >
            {claimAllLoading ? 'Claiming...' : `Claim All (${redeemableCount})`}
          </button>
        </div>
      </div>

      {/* Claim All result banner */}
      {claimAllResult && (
        <div
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid #1A1A1A',
            background: '#0E0E0E',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 12,
          }}
        >
          {claimAllResult.claimed && claimAllResult.claimed.length > 0 && (
            <div style={{ color: '#00D341', marginBottom: claimAllResult.failed.length > 0 ? 6 : 0 }}>
              Claimed {claimAllResult.claimed.length} position{claimAllResult.claimed.length !== 1 ? 's' : ''}
              {claimAllResult.claimed.map((c, i) => (
                <span key={i} style={{ display: 'block', color: '#888', paddingLeft: 8, fontSize: 11 }}>
                  {c.title} — {c.shares} shares
                  {c.txHash && c.txHash !== 'dry-run-simulated' && (
                    <a
                      href={`https://polygonscan.com/tx/${c.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: '#555', marginLeft: 6 }}
                    >
                      tx
                    </a>
                  )}
                </span>
              ))}
            </div>
          )}
          {claimAllResult.failed && claimAllResult.failed.length > 0 && (
            <div style={{ color: '#FF3B3B' }}>
              {claimAllResult.failed.length} failed
              {claimAllResult.failed.map((f, i) => (
                <span key={i} style={{ display: 'block', color: '#888', paddingLeft: 8, fontSize: 11 }}>
                  {f.title}: {f.error}
                </span>
              ))}
            </div>
          )}
          {claimAllResult.claimed && claimAllResult.claimed.length === 0 && claimAllResult.failed && claimAllResult.failed.length === 0 && (
            <div style={{ color: '#888' }}>No redeemable positions found</div>
          )}
          <button
            onClick={() => setClaimAllResult(null)}
            style={{ color: '#555', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, marginTop: 4 }}
          >
            dismiss
          </button>
        </div>
      )}

      {/* Scrollable table container */}
      <style>{`
        .trades-scroll::-webkit-scrollbar { width: 6px; }
        .trades-scroll::-webkit-scrollbar-track { background: #1A1A1A; }
        .trades-scroll::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
        @keyframes claimPulse {
          0%, 100% { box-shadow: 0 0 0px #00D341; }
          50% { box-shadow: 0 0 8px #00D341; }
        }
        .claim-btn {
          animation: claimPulse 1.5s infinite;
          transition: filter 150ms;
        }
        .claim-btn:hover { filter: brightness(1.3); }
        @media (max-width: 640px) {
          .trades-header { padding: 10px 12px; }
          .trades-header-right { width: 100%; flex-wrap: wrap; }
          .trades-filters { overflow-x: auto; -webkit-overflow-scrolling: touch; flex-shrink: 0; width: 100%; padding-bottom: 4px; }
          .claim-btn { width: 100%; text-align: center; padding: 8px !important; }
        }
      `}</style>
      <div className="trades-scroll" style={{ maxHeight: 600, overflowY: 'auto', overflowX: 'auto' }}>
        <table className="w-full" style={{ fontSize: '13px', fontFamily: '"JetBrains Mono", monospace' }}>
          <thead>
            <tr className="border-b border-border text-left" style={{ color: '#555', position: 'sticky', top: 0, background: '#0A0A0A', zIndex: 1 }}>
              <th className="px-2 py-2.5 font-normal text-xs" style={{ width: 28 }}></th>
              <th className="px-5 py-2.5 font-normal text-xs">Time</th>
              <th className="px-3 py-2.5 font-normal text-xs">Lane</th>
              <th className="px-3 py-2.5 font-normal text-xs">Side</th>
              <th className="px-3 py-2.5 font-normal text-xs">Entry $</th>
              <th className="px-3 py-2.5 font-normal text-xs">Cost</th>
              <th className="px-3 py-2.5 font-normal text-xs">Shares</th>
              <th className="px-3 py-2.5 font-normal text-xs">Irrev</th>
              <th className="px-3 py-2.5 font-normal text-xs">Payout</th>
              <th className="px-3 py-2.5 font-normal text-xs">P&L</th>
              <th className="px-3 py-2.5 font-normal text-xs">Result</th>
              <th className="px-3 py-2.5 font-normal text-xs">Action</th>
            </tr>
          </thead>
          <tbody>
            {paginated.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-5 py-6 text-center text-textSecondary text-xs font-mono">
                  No trades
                </td>
              </tr>
            ) : (
              paginated.map((trade, i) => {
                const result = trade.result || 'pending';
                const isBookmarked = !!trade.bookmarked;
                const borderColors = { won: '#00D341', lost: '#FF3B3B', pending: '#FFB800', expired: '#555', burned: '#555' };
                const hoverColors = { won: 'rgba(0,211,65,0.05)', lost: 'rgba(255,59,59,0.05)' };
                const rowBorder = isBookmarked ? '#00D341' : (borderColors[result] || '#555');
                const hoverBg = hoverColors[result] || 'rgba(26,26,26,0.8)';
                return (
                <tr
                  key={trade.id || i}
                  style={{
                    background: '#0A0A0A',
                    borderBottom: '1px solid #141414',
                    borderLeft: isBookmarked ? '2px solid #00D341' : `3px solid ${rowBorder}`,
                    transition: 'background 150ms',
                    cursor: 'default',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = hoverBg; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = '#0A0A0A'; }}
                >
                  <td className="px-2 py-2 whitespace-nowrap" style={{ width: 28 }}>
                    <Bookmark
                      size={14}
                      style={{
                        cursor: 'pointer',
                        color: isBookmarked ? '#00D341' : '#666',
                        fill: isBookmarked ? '#00D341' : 'none',
                        transition: 'color 150ms, fill 150ms',
                      }}
                      onClick={() => handleBookmark(trade.id, isBookmarked)}
                    />
                  </td>
                  <td className="px-5 py-2 whitespace-nowrap" style={{ color: '#555', fontSize: '12px' }}>
                    <div>{formatTime(trade.created_at)}</div>
                    <div style={{ fontSize: 10, color: '#444' }}>{formatDate(trade.created_at)}</div>
                  </td>
                  <td className="px-3 py-2 text-textPrimary whitespace-nowrap">
                    {trade.lane_id || '--'}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap" style={{ color: trade.side === 'UP' ? '#00D341' : '#FF3B3B' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      {trade.side === 'UP' ? <ChevronUp size={12} /> : trade.side === 'DOWN' ? <ChevronDown size={12} /> : null}
                      {trade.side || '--'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-textPrimary whitespace-nowrap">
                    ${Number(trade.entry_price || 0).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-textPrimary whitespace-nowrap">
                    {formatDollar(trade.cost)}
                  </td>
                  <td className="px-3 py-2 text-textPrimary whitespace-nowrap">
                    {Math.round(Number(trade.shares) || 0)}
                  </td>
                  <td className="px-3 py-2 text-textPrimary whitespace-nowrap">
                    {Number(trade.irrev || 0).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap" style={{ color: '#888' }}>
                    {result === 'won' ? formatDollar(Number(trade.shares) || 0) : result === 'lost' || result === 'burned' ? '$0.00' : <span style={{ color: '#333' }}>&mdash;</span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <PnlCell value={trade.pnl} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <ResultBadge result={result} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {trade.result === 'won' && trade.claimed ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'rgba(0,211,65,0.5)', fontSize: '12px' }}>
                          Claimed
                          {trade.claim_tx && trade.claim_tx !== 'dry-run-simulated' && (
                            <a
                              href={`https://polygonscan.com/tx/${trade.claim_tx}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              style={{ color: '#888', lineHeight: 0, transition: 'color 150ms' }}
                              onMouseEnter={(e) => { e.currentTarget.style.color = '#00D341'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = '#888'; }}
                            >
                              <ExternalLink size={14} />
                            </a>
                          )}
                        </span>
                      ) : null}
                      <TradeActionMenu tradeId={trade.id} onAction={loadTrades} />
                    </span>
                  </td>
                </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="px-5 py-3 border-t border-border flex items-center justify-between" style={{ fontFamily: '"JetBrains Mono", monospace' }}>
          <span style={{ color: '#555', fontSize: 11 }}>
            {filtered.length} trades · page {currentPage}/{totalPages}
          </span>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
              style={{
                background: '#1A1A1A',
                color: currentPage <= 1 ? '#333' : '#888',
                border: 'none',
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 11,
                cursor: currentPage <= 1 ? 'default' : 'pointer',
              }}
            >
              Prev
            </button>
            {getPageNumbers().map((p, idx) =>
              p === '...' ? (
                <span key={`dots-${idx}`} style={{ color: '#555', fontSize: 11, padding: '0 2px' }}>...</span>
              ) : (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  style={{
                    background: currentPage === p ? '#1A1A1A' : 'transparent',
                    color: currentPage === p ? '#00D341' : '#555',
                    border: 'none',
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 11,
                    fontWeight: currentPage === p ? 600 : 400,
                    cursor: 'pointer',
                  }}
                >
                  {p}
                </button>
              )
            )}
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages}
              style={{
                background: '#1A1A1A',
                color: currentPage >= totalPages ? '#333' : '#888',
                border: 'none',
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 11,
                cursor: currentPage >= totalPages ? 'default' : 'pointer',
              }}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
