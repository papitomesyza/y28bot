export function formatUsd(num) {
  const val = Number(num) || 0;
  return '$' + val.toFixed(2);
}

export function formatPrice(num, asset) {
  const val = Number(num) || 0;
  const decimals = asset && asset.toUpperCase() === 'BTC' ? 2 : 4;
  return val.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatTime(seconds) {
  const s = Math.floor(Number(seconds) || 0);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

export function formatDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  }) + ', ' + d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function formatPnl(num) {
  const val = Number(num) || 0;
  const sign = val >= 0 ? '+' : '';
  const color = val >= 0 ? '#00D341' : '#FF3B3B';
  return { text: `${sign}$${Math.abs(val).toFixed(2)}`, color };
}
