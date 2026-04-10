import { useMemo } from 'react';

function getDecimals(asset) {
  if (asset === 'BTC' || asset === 'ETH' || asset === 'HYPE') return 2;
  if (asset === 'SOL') return 4;
  return 6; // XRP
}

function formatPrice(price, decimals) {
  if (price == null) return '--';
  return Number(price).toFixed(decimals);
}

function formatCountdown(seconds) {
  if (seconds == null) return '--';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getCountdownColor(seconds) {
  if (seconds == null) return '#888888';
  if (seconds <= 10) return '#FF3B3B';
  if (seconds <= 30) return '#FFB800';
  return '#888888';
}

const GREEN = '#00D341';
const RED = '#FF3B3B';
const CANDLE_CHART_HEIGHT = 80;
const CANDLE_WIDTH = 8;
const WICK_WIDTH = 2;
const CANDLE_GAP = 4;

function MiniCandleChart({ completed, live, activeTrade }) {
  const allCandles = useMemo(() => {
    const candles = [...(completed || [])];
    if (live) {
      candles.push({
        open: live.open,
        high: live.high,
        low: live.low,
        close: live.current,
        direction: live.direction,
        isLive: true,
        tradeEntries: live.tradeEntries || [],
        resolved: false,
        resolvedDirection: null,
      });
    }
    return candles;
  }, [completed, live]);

  if (allCandles.length === 0) {
    return (
      <div style={{ height: CANDLE_CHART_HEIGHT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: '#333', fontSize: 10 }}>No data</span>
      </div>
    );
  }

  // Find global min/max for scaling
  let globalMin = Infinity;
  let globalMax = -Infinity;
  for (const c of allCandles) {
    if (c.high > globalMax) globalMax = c.high;
    if (c.low < globalMin) globalMin = c.low;
  }
  if (activeTrade?.entry_price) {
    if (activeTrade.entry_price > globalMax) globalMax = activeTrade.entry_price;
    if (activeTrade.entry_price < globalMin) globalMin = activeTrade.entry_price;
  }

  const range = globalMax - globalMin || 1;
  const padding = range * 0.1;
  const scaledMin = globalMin - padding;
  const scaledRange = range + padding * 2;

  function priceToY(price) {
    return CANDLE_CHART_HEIGHT - ((price - scaledMin) / scaledRange) * CANDLE_CHART_HEIGHT;
  }

  const totalWidth = allCandles.length * (CANDLE_WIDTH + CANDLE_GAP);

  return (
    <div style={{ position: 'relative', height: CANDLE_CHART_HEIGHT, overflow: 'hidden' }}>
      <style>{`
        @keyframes candlePulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
      <svg width="100%" height={CANDLE_CHART_HEIGHT} viewBox={`0 0 ${totalWidth} ${CANDLE_CHART_HEIGHT}`} preserveAspectRatio="xMaxYMid meet">
        {/* Entry price dashed line */}
        {activeTrade?.entry_price && (
          <>
            <line
              x1={0}
              y1={priceToY(activeTrade.entry_price)}
              x2={totalWidth}
              y2={priceToY(activeTrade.entry_price)}
              stroke="#FFB800"
              strokeWidth={1}
              strokeDasharray="3,3"
              opacity={0.7}
            />
            <text
              x={totalWidth - 2}
              y={priceToY(activeTrade.entry_price) - 3}
              textAnchor="end"
              fill="#FFB800"
              fontSize={7}
              fontFamily="JetBrains Mono, monospace"
              opacity={0.8}
            >
              {Number(activeTrade.entry_price).toFixed(2)}
            </text>
          </>
        )}

        {allCandles.map((candle, i) => {
          const x = i * (CANDLE_WIDTH + CANDLE_GAP);
          const isUp = (candle.close || candle.current || candle.open) >= candle.open;
          const color = isUp ? GREEN : RED;
          const bodyTop = priceToY(Math.max(candle.open, candle.close || candle.current || candle.open));
          const bodyBottom = priceToY(Math.min(candle.open, candle.close || candle.current || candle.open));
          const bodyHeight = Math.max(bodyBottom - bodyTop, 1);
          const wickTop = priceToY(candle.high);
          const wickBottom = priceToY(candle.low);
          const wickX = x + CANDLE_WIDTH / 2;

          const isFlip = candle.resolved && candle.resolvedDirection && candle.direction !== candle.resolvedDirection;

          // Check for trade entries on this candle
          const entries = candle.tradeEntries || [];

          return (
            <g key={i} style={candle.isLive ? { animation: 'candlePulse 1.5s ease-in-out infinite' } : undefined}>
              {/* Wick */}
              <line
                x1={wickX}
                y1={wickTop}
                x2={wickX}
                y2={wickBottom}
                stroke={color}
                strokeWidth={WICK_WIDTH}
                opacity={0.5}
              />
              {/* Body */}
              <rect
                x={x}
                y={bodyTop}
                width={CANDLE_WIDTH}
                height={bodyHeight}
                fill={color}
                rx={1}
              />
              {/* Flip dot */}
              {isFlip && (
                <circle
                  cx={wickX}
                  cy={CANDLE_CHART_HEIGHT - 3}
                  r={2}
                  fill="#FFB800"
                />
              )}
              {/* Trade entry triangles */}
              {entries.map((entry, ei) => {
                const ey = priceToY(entry.price);
                return (
                  <polygon
                    key={ei}
                    points={`${x - 1},${ey + 3} ${x - 1},${ey - 3} ${x + 3},${ey}`}
                    fill="#FFB800"
                    opacity={0.9}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function CandleCard({ laneId, live, completed, reliability, activeTrade }) {
  const asset = laneId.split('-')[0];
  const decimals = getDecimals(asset);
  const hasTrade = !!activeTrade;

  const openPrice = live?.open;
  const currentPrice = live?.current;
  const delta = openPrice != null && currentPrice != null && openPrice !== 0
    ? ((currentPrice - openPrice) / openPrice) * 100
    : null;

  const liveDirection = live?.direction;
  const isUp = liveDirection === 'UP';
  const remainingSeconds = live?.remainingSeconds;
  const countdownColor = getCountdownColor(remainingSeconds);

  const flipRate = reliability?.flipRate ?? 0;
  const flipPct = (flipRate * 100).toFixed(1);

  const tradeArrow = activeTrade?.direction === 'UP' ? '\u25B2' : activeTrade?.direction === 'DOWN' ? '\u25BC' : null;
  const tradeArrowColor = activeTrade?.direction === 'UP' ? GREEN : RED;

  return (
    <div
      style={{
        backgroundColor: '#0A0A0A',
        border: `1px solid ${hasTrade ? '#2A2A2A' : '#1A1A1A'}`,
        borderRadius: 8,
        padding: '10px 12px',
        fontFamily: '"JetBrains Mono", monospace',
        minWidth: 220,
        width: 220,
        flexShrink: 0,
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: '#FFFFFF', fontWeight: 700, fontSize: 12 }}>{laneId}</span>
          {tradeArrow && (
            <span style={{ color: tradeArrowColor, fontSize: 10, fontWeight: 700 }}>{tradeArrow}</span>
          )}
          {liveDirection && (
            <span style={{ color: isUp ? GREEN : RED, fontSize: 10, fontWeight: 600 }}>
              {liveDirection}
            </span>
          )}
        </div>
        <span style={{ color: countdownColor, fontSize: 11, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {formatCountdown(remainingSeconds)}
        </span>
      </div>

      {/* Mini candle chart */}
      <MiniCandleChart
        completed={completed}
        live={live}
        activeTrade={activeTrade}
      />

      {/* Bottom row: O/C prices + delta */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
        <div style={{ fontSize: 10, color: '#888' }}>
          <span>O </span>
          <span style={{ color: '#FFFFFF' }}>{formatPrice(openPrice, decimals)}</span>
          <span style={{ margin: '0 4px' }}>|</span>
          <span>C </span>
          <span style={{ color: '#FFFFFF' }}>{formatPrice(currentPrice, decimals)}</span>
        </div>
        {delta != null && (
          <span style={{ fontSize: 10, color: delta >= 0 ? GREEN : RED, fontWeight: 600 }}>
            {delta >= 0 ? '+' : ''}{delta.toFixed(2)}%
          </span>
        )}
      </div>

      {/* Flip rate */}
      <div style={{ marginTop: 4, fontSize: 9, color: '#555' }}>
        Flip: {flipPct}%
        {reliability?.observed > 0 && (
          <span style={{ marginLeft: 4 }}>
            ({reliability.flipped}/{reliability.observed})
          </span>
        )}
      </div>
    </div>
  );
}
