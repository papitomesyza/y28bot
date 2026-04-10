import { useState, useEffect, useRef, useCallback } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { searchLogs } from '../utils/api.js';

const PRIMARY_FILTERS = [
  { label: 'All', match: null },
  { label: 'Scalp', match: '[scalp]' },
  { label: 'Executor', match: '[executor]' },
  { label: 'Resolver', match: '[resolver]' },
  { label: 'Spread', match: '[spread-scalp]' },
  { label: 'Trade', match: ['[trade]', '[signal]'] },
];

const TAG_FILTERS = [
  { label: 'Balance', test: (log) => /balance|Pool balance/i.test(log.message) },
  { label: 'Won', test: (log) => /won/i.test(log.message) },
  { label: 'Lost', test: (log) => /lost/i.test(log.message) },
  { label: 'Claimed', test: (log) => /claim/i.test(log.message) },
  { label: 'Expired', test: (log) => /expired/i.test(log.message) },
  { label: 'Errors', test: (log) => log.level === 'error' },
  { label: 'Signals', test: (log) => log.message.includes('[signal]') },
  { label: 'Market', test: (log) => log.message.includes('[MarketDiscovery]') },
  { label: 'Window', test: (log) => log.message.includes('Window transition') },
];

function getLineColor(log) {
  if (log.level === 'error' || log.message.includes('[error]')) return '#FF3B3B';
  if (log.message.includes('[trade]') || log.message.includes('[signal]')) return '#FFFFFF';
  return '#00D341';
}

function formatTimestamp(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return ts;
  }
}

function matchesPrimary(log, filter) {
  if (!filter.match) return true;
  if (Array.isArray(filter.match)) {
    return filter.match.some((m) => log.message.includes(m));
  }
  return log.message.includes(filter.match);
}

function matchesTags(log, activeTags) {
  if (activeTags.size === 0) return true;
  for (const idx of activeTags) {
    if (TAG_FILTERS[idx].test(log)) return true;
  }
  return false;
}

export default function LogsPanel({ logs }) {
  const [activeFilter, setActiveFilter] = useState(0);
  const [activeTags, setActiveTags] = useState(new Set());
  const [copied, setCopied] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const bodyRef = useRef(null);
  const userScrollingRef = useRef(false);
  const debounceRef = useRef(null);

  function handleSearchChange(e) {
    const value = e.target.value;
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value.trim()) {
      setSearchResults(null);
      return;
    }
    debounceRef.current = setTimeout(() => {
      searchLogs(value.trim()).then(setSearchResults).catch(() => {});
    }, 300);
  }

  function toggleTag(idx) {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  const primaryFilter = PRIMARY_FILTERS[activeFilter];
  const baseLogs = searchResults !== null ? searchResults : logs;
  const filtered = baseLogs.filter((log) => matchesPrimary(log, primaryFilter) && matchesTags(log, activeTags));

  const handleScroll = useCallback(() => {
    if (!bodyRef.current) return;
    const el = bodyRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    if (!atBottom && !userScrollingRef.current) {
      userScrollingRef.current = true;
      setAutoScroll(false);
    }
    if (atBottom && userScrollingRef.current) {
      userScrollingRef.current = false;
    }
  }, []);

  function toggleAutoScroll() {
    const next = !autoScroll;
    setAutoScroll(next);
    userScrollingRef.current = false;
    if (next && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }

  useEffect(() => {
    if (autoScroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [filtered.length, autoScroll, activeFilter, activeTags]);

  function handleCopy() {
    const text = filtered.map((l) => `${l.timestamp} ${l.message}`).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="bg-card border border-border rounded-lg">
      {/* Header */}
      <div className="px-5 py-3 border-b border-border">
        {/* Search bar */}
        <div className="mb-2">
          <input
            type="text"
            value={searchQuery}
            onChange={handleSearchChange}
            placeholder="Filter logs (e.g. momentum-gate, executor, scalp...)"
            style={{
              width: '100%',
              background: '#0A0A0A',
              border: '1px solid #1A1A1A',
              color: '#FFFFFF',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: '12px',
              padding: '8px',
              borderRadius: '4px',
              outline: 'none',
            }}
          />
        </div>
        <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
          <span className="text-textPrimary text-sm font-mono font-bold">Runtime Logs</span>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Primary filter pills */}
            <div className="flex gap-1">
              {PRIMARY_FILTERS.map((f, i) => (
                <button
                  key={f.label}
                  onClick={() => setActiveFilter(i)}
                  className="px-2.5 py-1 rounded-full text-xs font-mono transition-colors"
                  style={{
                    background: activeFilter === i ? '#00D341' : 'transparent',
                    color: activeFilter === i ? '#0C0C0C' : '#888888',
                    border: activeFilter === i ? 'none' : '1px solid #1A1A1A',
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* Copy button */}
            <button
              onClick={handleCopy}
              className="px-3 py-1 rounded text-xs font-mono transition-colors"
              style={{
                color: copied ? '#0C0C0C' : '#00D341',
                background: copied ? '#00D341' : 'transparent',
                border: '1px solid #00D341',
              }}
            >
              {copied ? 'Copied' : 'Copy Filtered'}
            </button>

            {/* Auto-scroll toggle */}
            <button
              onClick={toggleAutoScroll}
              className="px-2.5 py-1 rounded-full text-xs font-mono transition-colors"
              style={{
                color: autoScroll ? '#00D341' : '#666666',
                background: 'transparent',
                border: `1px solid ${autoScroll ? '#00D341' : '#1A1A1A'}`,
              }}
            >
              Auto ↓
            </button>

            {/* Expand/collapse toggle */}
            <button
              onClick={() => setExpanded((prev) => !prev)}
              className="px-2 py-1 rounded-full text-xs font-mono transition-colors flex items-center gap-1"
              style={{
                color: expanded ? '#00D341' : '#666666',
                background: 'transparent',
                border: `1px solid ${expanded ? '#00D341' : '#1A1A1A'}`,
              }}
              title={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          </div>
        </div>

        {/* Row 2 — Tag filters */}
        <div className="flex gap-1.5 flex-wrap">
          {TAG_FILTERS.map((tag, i) => {
            const active = activeTags.has(i);
            return (
              <button
                key={tag.label}
                onClick={() => toggleTag(i)}
                className="px-2 py-0.5 rounded-full font-mono transition-colors"
                style={{
                  fontSize: 10,
                  background: active ? 'transparent' : '#1A1A1A',
                  color: active ? '#00D341' : '#666666',
                  border: active ? '1px solid #00D341' : '1px solid transparent',
                }}
              >
                {tag.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Body */}
      <div
        ref={bodyRef}
        onScroll={handleScroll}
        className="px-5 py-3 overflow-y-auto logs-scrollbar"
        style={{ maxHeight: expanded ? '70vh' : '200px' }}
      >
        {filtered.length === 0 ? (
          <span className="text-textSecondary text-xs font-mono">No logs</span>
        ) : (
          filtered.map((log, i) => (
            <div key={i} className="flex gap-3 leading-5" style={{ fontSize: '12px', fontFamily: '"JetBrains Mono", monospace' }}>
              <span style={{ color: '#555', whiteSpace: 'nowrap' }}>{formatTimestamp(log.timestamp)}</span>
              <span style={{ color: getLineColor(log) }}>{log.message}</span>
            </div>
          ))
        )}
      </div>

      <style>{`
        .logs-scrollbar::-webkit-scrollbar { width: 6px; }
        .logs-scrollbar::-webkit-scrollbar-track { background: #1A1A1A; border-radius: 3px; }
        .logs-scrollbar::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
        .logs-scrollbar::-webkit-scrollbar-thumb:hover { background: #444; }
        .logs-scrollbar { scrollbar-width: thin; scrollbar-color: #333 #1A1A1A; }
      `}</style>
    </div>
  );
}
