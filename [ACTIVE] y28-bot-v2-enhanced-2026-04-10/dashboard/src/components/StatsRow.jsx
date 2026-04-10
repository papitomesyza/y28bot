export default function StatsRow({ status }) {
  const pool = status?.pool ?? 0;
  const yesterdayPool = status?.yesterdayPool;
  const stats = status?.stats ?? {};
  const todayPnl = stats.todayPnl ?? 0;
  const winRate = stats.winRate ?? 0;
  const wins = stats.wins ?? 0;
  const losses = stats.losses ?? 0;
  const pending = stats.pending ?? 0;
  const total = stats.totalTrades ?? 0;
  const decided = wins + losses;

  // Pool balance color — compare to yesterday
  let poolColor = '#FFFFFF';
  let poolChangeText = null;
  if (yesterdayPool != null && yesterdayPool > 0) {
    if (pool > yesterdayPool) poolColor = '#00D341';
    else if (pool < yesterdayPool) poolColor = '#FF3B3B';
    const pctChange = ((pool - yesterdayPool) / yesterdayPool) * 100;
    const sign = pctChange >= 0 ? '+' : '';
    poolChangeText = `${sign}${pctChange.toFixed(1)}% from yesterday`;
  }

  // P&L color
  const pnlColor = todayPnl > 0 ? '#00D341' : todayPnl < 0 ? '#FF3B3B' : '#FFFFFF';
  const pnlPrefix = todayPnl > 0 ? '+' : '';

  // Win rate color
  let winRateColor = '#FFFFFF';
  if (decided > 0) {
    const pct = winRate * 100;
    if (pct >= 70) winRateColor = '#00D341';
    else if (pct >= 50) winRateColor = '#FFB800';
    else winRateColor = '#FF3B3B';
  }

  return (
    <>
    <style>{`
      @media (max-width: 640px) {
        .stat-value { font-size: 16px !important; }
        .stat-subtitle { font-size: 10px !important; overflow-wrap: break-word; word-wrap: break-word; }
      }
    `}</style>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {/* Pool Balance */}
      <div className="bg-card border border-border rounded-lg px-4 py-3.5">
        <span className="text-textSecondary text-xs font-mono block mb-0.5">Pool Balance</span>
        <span className="text-xl font-mono font-bold stat-value" style={{ color: poolColor }}>
          ${pool.toFixed(2)}
        </span>
        {poolChangeText && (
          <span className="block mt-0.5 text-xs font-mono stat-subtitle" style={{ color: '#888888' }}>
            {poolChangeText}
          </span>
        )}
      </div>

      {/* Today P&L */}
      <div className="bg-card border border-border rounded-lg px-4 py-3.5">
        <span className="text-textSecondary text-xs font-mono block mb-0.5">Today P&L</span>
        <span className="text-xl font-mono font-bold stat-value" style={{ color: pnlColor }}>
          {pnlPrefix}${Math.abs(todayPnl).toFixed(2)}
        </span>
      </div>

      {/* Win Rate */}
      <div className="bg-card border border-border rounded-lg px-4 py-3.5">
        <span className="text-textSecondary text-xs font-mono block mb-0.5">Win Rate</span>
        <span className="text-xl font-mono font-bold stat-value" style={{ color: winRateColor }}>
          {(winRate * 100).toFixed(1)}%
        </span>
        <span className="text-textSecondary text-xs font-mono block mt-0.5 stat-subtitle">
          {wins} wins / {decided} total
        </span>
      </div>

      {/* Total Trades */}
      <div className="bg-card border border-border rounded-lg px-4 py-3.5">
        <span className="text-textSecondary text-xs font-mono block mb-0.5">Total Trades</span>
        <span className="text-textPrimary text-xl font-mono font-bold stat-value">{total}</span>
        <span className="text-textSecondary text-xs font-mono block mt-0.5 stat-subtitle">
          {wins} won · {losses} lost · {pending} pending
        </span>
      </div>
    </div>
    </>
  );
}
