import { useState, useEffect, useRef } from 'react';
import { TrendingUp, TrendingDown, Shield, Activity } from 'lucide-react';
import { fetchV2Positions, fetchV2Lanes } from '../utils/api.js';

function formatDollar(v) {
  const n = Number(v);
  if (isNaN(n)) return '$0.00';
  return (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2);
}

function StatusBadge({ position }) {
  if (position.hedge_shares > 0) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono"
        style={{ background: 'rgba(139,92,246,0.15)', color: '#A78BFA' }}>
        <Shield size={10} /> HEDGING
      </span>
    );
  }
  if (position.entry_count > 0) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono"
        style={{ background: 'rgba(0,211,65,0.15)', color: '#00D341' }}>
        <Activity size={10} /> ACCUMULATING
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono"
      style={{ background: 'rgba(255,184,0,0.15)', color: '#FFB800' }}>
      OBSERVING
    </span>
  );
}

function TimeRemaining({ windowTs, interval }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!windowTs || !interval) return <span style={{ color: '#555' }}>--</span>;

  const intervalMs = interval === '1H' ? 3600000 : 14400000;
  const endMs = new Date(windowTs).getTime() + intervalMs;
  const remaining = Math.max(0, endMs - now);

  if (remaining === 0) return <span style={{ color: '#FF3B3B' }}>EXPIRED</span>;

  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  const color = mins < 5 ? '#FF3B3B' : mins < 15 ? '#FFB800' : '#888';

  return <span style={{ color, fontVariantNumeric: 'tabular-nums' }}>{mins}m {secs.toString().padStart(2, '0')}s</span>;
}

function DirectionIcon({ direction }) {
  if (direction === 'UP') {
    return <span className="inline-flex items-center gap-1" style={{ color: '#00D341' }}><TrendingUp size={14} /> UP</span>;
  }
  if (direction === 'DOWN') {
    return <span className="inline-flex items-center gap-1" style={{ color: '#FF3B3B' }}><TrendingDown size={14} /> DOWN</span>;
  }
  return <span style={{ color: '#555' }}>--</span>;
}

function PositionCard({ pos }) {
  const netExposure = (Number(pos.total_shares) || 0) - (Number(pos.hedge_shares) || 0);
  const tier = pos.interval === '1H' || pos.tier === '1H' ? '1H' : '4H';

  return (
    <div style={{
      background: 'rgba(255,255,255,0.05)',
      backdropFilter: 'blur(10px)',
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 12,
      padding: 16,
      fontFamily: '"JetBrains Mono", monospace',
    }}>
      {/* Top row: lane + direction + status */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-textPrimary text-sm font-bold">{pos.lane_id}</span>
          <span className="px-1.5 py-0.5 rounded text-xs"
            style={{ background: '#1A1A1A', color: '#888' }}>{tier}</span>
          <DirectionIcon direction={pos.direction} />
        </div>
        <StatusBadge position={pos} />
      </div>

      {/* Entries progress */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <span style={{ color: '#888', fontSize: 11 }}>Entries</span>
          <span style={{ color: '#FFF', fontSize: 12 }}>{pos.entry_count || 0}/{pos.max_entries || 16}</span>
        </div>
        <div style={{ background: '#1A1A1A', borderRadius: 4, height: 4, overflow: 'hidden' }}>
          <div style={{
            background: '#00D341',
            height: '100%',
            width: `${Math.min(100, ((pos.entry_count || 0) / (pos.max_entries || 16)) * 100)}%`,
            borderRadius: 4,
            transition: 'width 300ms',
          }} />
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 mb-3" style={{ fontSize: 12 }}>
        <div>
          <span style={{ color: '#555' }}>Shares</span>
          <div style={{ color: '#FFF' }}>{Math.round(Number(pos.total_shares) || 0)}</div>
        </div>
        <div>
          <span style={{ color: '#555' }}>Avg Entry</span>
          <div style={{ color: '#FFF' }}>{formatDollar(pos.avg_entry_price)}</div>
        </div>
        <div>
          <span style={{ color: '#555' }}>Total Cost</span>
          <div style={{ color: '#FFF' }}>{formatDollar(pos.total_cost)}</div>
        </div>
        <div>
          <span style={{ color: '#555' }}>Net Exposure</span>
          <div style={{ color: '#FFF' }}>{Math.round(netExposure)}</div>
        </div>
        {(Number(pos.hedge_shares) || 0) > 0 && (
          <>
            <div>
              <span style={{ color: '#555' }}>Hedge</span>
              <div style={{ color: '#A78BFA' }}>{Math.round(Number(pos.hedge_shares))} shr</div>
            </div>
            <div>
              <span style={{ color: '#555' }}>Hedge Cost</span>
              <div style={{ color: '#A78BFA' }}>{formatDollar(pos.hedge_cost)}</div>
            </div>
          </>
        )}
      </div>

      {/* P&L projections */}
      <div className="flex gap-3 mb-3" style={{ fontSize: 11 }}>
        <div className="flex-1 rounded px-2 py-1.5" style={{ background: 'rgba(0,211,65,0.08)' }}>
          <span style={{ color: '#555' }}>If Win</span>
          <div style={{ color: '#00D341', fontWeight: 600 }}>
            {pos.projected_pnl_win != null ? formatDollar(pos.projected_pnl_win) : '--'}
          </div>
        </div>
        <div className="flex-1 rounded px-2 py-1.5" style={{ background: 'rgba(255,59,59,0.08)' }}>
          <span style={{ color: '#555' }}>If Loss</span>
          <div style={{ color: '#FF3B3B', fontWeight: 600 }}>
            {pos.projected_pnl_loss != null ? formatDollar(pos.projected_pnl_loss) : '--'}
          </div>
        </div>
      </div>

      {/* Time remaining */}
      <div className="flex items-center justify-between" style={{ fontSize: 11 }}>
        <span style={{ color: '#555' }}>Time Remaining</span>
        <TimeRemaining windowTs={pos.window_ts} interval={tier} />
      </div>
    </div>
  );
}

function ResolvedRow({ pos }) {
  const pnl = Number(pos.pnl) || 0;
  const resultColors = { won: '#00D341', lost: '#FF3B3B', mixed: '#FFB800' };
  const result = pos.result || 'unknown';

  return (
    <tr style={{
      borderBottom: '1px solid #141414',
      borderLeft: `3px solid ${resultColors[result] || '#555'}`,
    }}>
      <td className="px-4 py-2 whitespace-nowrap" style={{ color: '#555', fontSize: 12 }}>
        {pos.resolved_at ? new Date(pos.resolved_at).toLocaleString('en-GB', {
          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
        }) : '--'}
      </td>
      <td className="px-3 py-2 text-textPrimary whitespace-nowrap text-sm">{pos.lane_id}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        <DirectionIcon direction={pos.direction} />
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-sm" style={{ color: '#888' }}>{pos.entry_count || 0}</td>
      <td className="px-3 py-2 whitespace-nowrap text-sm" style={{ color: '#888' }}>{formatDollar(pos.total_cost)}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        <span style={{
          display: 'inline-block',
          padding: '1px 6px',
          borderRadius: 4,
          fontSize: 12,
          fontWeight: 500,
          background: pnl > 0 ? 'rgba(0,211,65,0.12)' : pnl < 0 ? 'rgba(255,59,59,0.12)' : 'transparent',
          color: pnl > 0 ? '#00D341' : pnl < 0 ? '#FF3B3B' : '#555',
        }}>
          {pnl >= 0 ? '+' : ''}{formatDollar(pnl)}
        </span>
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <span className="px-2 py-0.5 rounded text-xs font-mono capitalize font-semibold" style={{
          background: `${resultColors[result] || '#555'}22`,
          color: resultColors[result] || '#888',
        }}>
          {result}
        </span>
      </td>
    </tr>
  );
}

export default function V2Positions() {
  const [positions, setPositions] = useState(null);
  const [lanes, setLanes] = useState(null);
  const intervalRef = useRef(null);

  function load() {
    fetchV2Positions().then(setPositions).catch(() => {});
    fetchV2Lanes().then(setLanes).catch(() => {});
  }

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 5000);
    return () => clearInterval(intervalRef.current);
  }, []);

  const allPositions = Array.isArray(positions) ? positions : (positions?.positions || []);
  const active = allPositions.filter(p => p.result === 'active' || !p.result);
  const resolved = allPositions.filter(p => p.result && p.result !== 'active').slice(0, 20);

  return (
    <div className="flex flex-col gap-4">
      {/* Active DCA Positions */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Activity size={16} style={{ color: '#00D341' }} />
          <span style={{ color: '#888', fontSize: 11, fontFamily: '"JetBrains Mono", monospace', textTransform: 'uppercase', letterSpacing: 1 }}>
            Active DCA Positions
          </span>
          <span className="px-1.5 py-0.5 rounded text-xs font-mono" style={{ background: '#1A1A1A', color: '#00D341' }}>
            {active.length}
          </span>
        </div>

        {active.length === 0 ? (
          <div style={{
            background: 'rgba(255,255,255,0.05)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 12,
            padding: 24,
            textAlign: 'center',
          }}>
            <span style={{ color: '#555', fontSize: 13, fontFamily: '"JetBrains Mono", monospace' }}>
              No active DCA positions
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {active.map((pos, i) => (
              <PositionCard key={pos.id || pos.lane_id + '-' + i} pos={pos} />
            ))}
          </div>
        )}
      </div>

      {/* Lane Status */}
      {lanes && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <span style={{ color: '#888', fontSize: 11, fontFamily: '"JetBrains Mono", monospace', textTransform: 'uppercase', letterSpacing: 1 }}>
              V2 Lane Status
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {(Array.isArray(lanes) ? lanes : (lanes?.lanes || Object.entries(lanes || {}).map(([id, data]) => ({ lane_id: id, ...data })))).map((lane, i) => {
              const laneId = lane.lane_id || lane.id || `lane-${i}`;
              const isActive = lane.active !== false && lane.paused !== true;
              return (
                <div key={laneId} className="px-3 py-2 rounded-lg text-xs font-mono" style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: `1px solid ${isActive ? 'rgba(0,211,65,0.3)' : 'rgba(255,255,255,0.1)'}`,
                  color: isActive ? '#FFF' : '#555',
                }}>
                  <span className="font-bold">{laneId}</span>
                  {lane.trend && <span style={{ color: lane.trend === 'UP' ? '#00D341' : '#FF3B3B', marginLeft: 6 }}>{lane.trend}</span>}
                  {lane.consecutive_losses > 0 && (
                    <span style={{ color: '#FF3B3B', marginLeft: 6 }}>{lane.consecutive_losses}L</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent Resolved Positions */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <span style={{ color: '#888', fontSize: 11, fontFamily: '"JetBrains Mono", monospace', textTransform: 'uppercase', letterSpacing: 1 }}>
            Recent Resolved Positions
          </span>
          <span className="px-1.5 py-0.5 rounded text-xs font-mono" style={{ background: '#1A1A1A', color: '#888' }}>
            {resolved.length}
          </span>
        </div>

        <div style={{
          background: 'rgba(255,255,255,0.05)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 12,
          overflow: 'hidden',
        }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="w-full" style={{ fontSize: 13, fontFamily: '"JetBrains Mono", monospace' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', color: '#555' }}>
                  <th className="px-4 py-2.5 text-left font-normal text-xs">Time</th>
                  <th className="px-3 py-2.5 text-left font-normal text-xs">Lane</th>
                  <th className="px-3 py-2.5 text-left font-normal text-xs">Dir</th>
                  <th className="px-3 py-2.5 text-left font-normal text-xs">Entries</th>
                  <th className="px-3 py-2.5 text-left font-normal text-xs">Cost</th>
                  <th className="px-3 py-2.5 text-left font-normal text-xs">P&L</th>
                  <th className="px-3 py-2.5 text-left font-normal text-xs">Result</th>
                </tr>
              </thead>
              <tbody>
                {resolved.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-6 text-center text-xs font-mono" style={{ color: '#555' }}>
                      No resolved positions yet
                    </td>
                  </tr>
                ) : (
                  resolved.map((pos, i) => <ResolvedRow key={pos.id || i} pos={pos} />)
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
