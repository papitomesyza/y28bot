const axios = require('axios');
const config = require('./config');

class Notifications {
  constructor() {
    this.enabled = !!(config.telegramBotToken && config.telegramChatId && !config.dryRun);
  }

  async send(message) {
    if (!this.enabled) return;
    try {
      await axios.post(
        `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
        { chat_id: config.telegramChatId, text: message, parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error(`[notify] Telegram error: ${err.message}`);
    }
  }

  tradeEntry(trade) {
    this.send(
      `🟢 NEW TRADE\nLane: ${trade.laneId}\nSide: ${trade.direction}\nEntry: $${trade.entryPrice}\nShares: ${trade.shares}\nCost: $${trade.cost}\nIrrev: ${trade.irrev}\nType: ${trade.type}`
    );
  }

  tradeResult(trade, poolBalance) {
    this.send(
      `${trade.result === 'won' ? '✅ WON' : '❌ LOST'}\nLane: ${trade.lane_id}\nSide: ${trade.side}\nP&L: ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl}\nPool: $${poolBalance}`
    );
  }

  botPaused() {
    this.send('⏸ Bot PAUSED');
  }

  botResumed() {
    this.send('▶ Bot RESUMED');
  }

  unclaimedWinsFound(count) {
    this.send(`💰 ${count} unclaimed win(s) found — claiming...`);
  }

  error(message) {
    this.send(`🚨 ERROR: ${message}`);
  }
}

module.exports = new Notifications();
