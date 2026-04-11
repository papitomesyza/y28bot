import { useState, useEffect, useRef } from 'react';
import { fetchCandles, fetchTrades } from '../utils/api.js';
import CandleCard from './CandleCard.jsx';

export default function CandlesGrid() {
  const [candles, setCandles] = useState(null);
  const [pendingTrades, setPendingTrades] = useState([]);
  const intervalRef = useRef(null);

  function load() {
    fetchCandles().then(setCandles).catch(() => {});
    fetchTrades({ result: 'pending' })
      .then((trades) => {
        const pending = Array.isArray(trades) ? trades.filter(t => t.result === 'pending') : [];
        setPendingTrades(pending);
      })
      .catch(() => {});
  }

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 2000);
    return () => clearInterval(intervalRef.current);
  }, []);

  if (!candles) {
    return (
      <div style={{ background: '#0A0A0A', border: '1px solid #1A1A1A', borderRadius: 8, padding: 16 }}>
        <span style={{ color: '#888888', fontSize: 14, fontFamily: '"JetBrains Mono", monospace' }}>Loading candles...</span>
      </div>
    );
  }

  const laneIds = Object.keys(candles);
  if (laneIds.length === 0) return null;

  // Order lanes as asset pairs: BTC-5M, BTC-15M, ETH-5M, ETH-15M, ...
  const ASSET_ORDER = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE'];
  const WINDOW_ORDER = ['5M', '15M'];
  const orderedLaneIds = [];
  for (const asset of ASSET_ORDER) {
    for (const window of WINDOW_ORDER) {
      const id = `${asset}-${window}`;
      if (laneIds.includes(id)) orderedLaneIds.push(id);
    }
  }
  // Append any remaining lanes not in the predefined order
  for (const id of laneIds) {
    if (!orderedLaneIds.includes(id)) orderedLaneIds.push(id);
  }

  // Match pending trades to lanes
  function getActiveTrade(laneId) {
    const trade = pendingTrades.find(t => t.lane_id === laneId);
    if (!trade) return null;
    return { entry_price: trade.entry_price, direction: trade.side };
  }

  // Build cards with dividers between asset pairs
  const items = [];
  for (let i = 0; i < orderedLaneIds.length; i++) {
    const laneId = orderedLaneIds[i];
    const data = candles[laneId];
    items.push(
      <CandleCard
        key={laneId}
        laneId={laneId}
        live={data.live}
        completed={data.completed}
        reliability={data.reliability}
        activeTrade={getActiveTrade(laneId)}
      />
    );
    // Add divider after every 15M card (end of a pair), except after the last card
    const asset = laneId.split('-')[0];
    const window = laneId.split('-')[1];
    if (window === '15M' && i < orderedLaneIds.length - 1) {
      items.push(
        <div
          key={`div-${asset}`}
          style={{
            width: 1,
            alignSelf: 'center',
            height: '80%',
            backgroundColor: '#1A1A1A',
            flexShrink: 0,
          }}
        />
      );
    }
  }

  return (
    <>
      <style>{`
        .candles-scroll::-webkit-scrollbar {
          height: 6px;
        }
        .candles-scroll::-webkit-scrollbar-track {
          background: #1A1A1A;
          border-radius: 3px;
        }
        .candles-scroll::-webkit-scrollbar-thumb {
          background: #333;
          border-radius: 3px;
        }
        .candles-scroll {
          scrollbar-width: thin;
          scrollbar-color: #333 #1A1A1A;
        }
      `}</style>
      <div style={{ marginBottom: 8 }}>
        <span style={{ color: '#888', fontSize: 11, fontFamily: '"JetBrains Mono", monospace', textTransform: 'uppercase', letterSpacing: 1 }}>CANDLES</span>
      </div>
      <div
        className="candles-scroll"
        style={{
          display: 'flex',
          flexDirection: 'row',
          gap: 10,
          overflowX: 'auto',
          paddingBottom: 8,
        }}
      >
        {items}
      </div>
    </>
  );
}
