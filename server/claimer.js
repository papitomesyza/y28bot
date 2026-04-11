const config = require('./config');
const db = require('./db');
const notifications = require('./notifications');
const axios = require('axios');
const { ethers } = require('ethers');
const { spreadScalp } = require('./spread-scalp');

const CLAIMED_BLACKLIST = new Set([
  'b3114dc4a641074bce619ea2bc010eb036d4d86d0e252b4747e3ab45d486ef3c',
  'de06508942f7f7d83bdbfc7c5b07c88e20891e9ef7440d74c9c259f2347fb8d3',
  'd167df1a2c61fb4b3b6ff2857d040812b584fd1915ff8522eeb37f0d5f13585f',
]);

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_ABI = ['function balanceOf(address account) view returns (uint256)'];

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
];

const RPC_ENDPOINTS = [
  'https://polygon-rpc.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.llamarpc.com',
  'https://poly-rpc.gateway.pokt.network',
];

const DATA_API_BASE = 'https://data-api.polymarket.com';

class Claimer {
  constructor() {
    this.claimLock = false;
    this.claimLockTime = 0;
    this.provider = null;
    this.wallet = null;
    this.proxyWallet = null;
    this._lastClaimNotifyTime = 0;
    this._oracleTimer = null;

    // Load persisted blacklist from settings DB
    try {
      const saved = db.getSetting('claimBlacklist');
      this.claimBlacklist = saved ? new Set(JSON.parse(saved)) : new Set();
      if (this.claimBlacklist.size > 0) {
        console.log(`[claimer] Loaded ${this.claimBlacklist.size} blacklisted conditionIds from DB`);
      }
    } catch (err) {
      console.error(`[claimer] Failed to load claimBlacklist from DB:`, err.message);
      this.claimBlacklist = new Set();
    }
  }

  /**
   * Get the effective wallet address for Data API queries.
   * Polymarket uses proxy wallets — the Data API indexes by proxy, not EOA.
   */
  async getDataApiWallet() {
    const eoaAddress = config.walletAddress;

    if (this.proxyWallet) return this.proxyWallet;

    // Try EOA first
    try {
      const resp = await axios.get(`${DATA_API_BASE}/positions?user=${eoaAddress}`);
      if (Array.isArray(resp.data) && resp.data.length > 0) {
        return eoaAddress;
      }
    } catch (err) {
      console.error(`[claimer] Data API EOA check failed:`, err.message);
    }

    // Try proxy wallet via CLOB endpoint
    try {
      const resp = await axios.get(`https://clob.polymarket.com/proxy-wallet?address=${eoaAddress}`);
      if (resp.data && resp.data.address) {
        this.proxyWallet = resp.data.address;
        console.log(`[claimer] Resolved proxy wallet: ${this.proxyWallet}`);
        return this.proxyWallet;
      }
    } catch (err) {
      console.log(`[claimer] Proxy wallet lookup failed: ${err.message}`);
    }

    console.log(`[claimer] No proxy wallet found, using EOA: ${eoaAddress}`);
    return eoaAddress;
  }

  // ── Data API: single source of truth ──────────────────────────────

  /**
   * Fetch all redeemable positions from the Data API.
   * Filters to: redeemable === true, curPrice === 1 (winners), size > 0.
   */
  async getRedeemablePositions() {
    const wallet = await this.getDataApiWallet();
    try {
      const resp = await axios.get(`${DATA_API_BASE}/positions?user=${wallet}`);
      const all = Array.isArray(resp.data) ? resp.data : [];
      console.log(`[claimer] Data API returned ${all.length} total positions for ${wallet}`);

      // Resolve pending trades using the same Data API positions (no extra API call)
      this.resolveTradesFromOracle(all);

      const redeemable = all.filter((p) => {
        const isRedeemable = p.redeemable === true || p.redeemable === 'true';
        const isWinner = parseFloat(p.curPrice) === 1;
        const hasShares = parseFloat(p.size) > 0;
        if (isRedeemable && isWinner && hasShares && this.claimBlacklist.has(p.conditionId)) {
          console.log(`[claimer] Skipping blacklisted conditionId ${p.conditionId}`);
          return false;
        }
        return isRedeemable && isWinner && hasShares;
      });

      const beforeBlacklist = redeemable.length;
      const filtered = redeemable.filter((p) => {
        const raw = (p.conditionId || '').replace(/^0x/, '');
        return !CLAIMED_BLACKLIST.has(raw);
      });
      const blacklistedCount = beforeBlacklist - filtered.length;
      if (blacklistedCount > 0) {
        console.log(`[claimer] Filtered ${blacklistedCount} blacklisted position(s) from redeemable list`);
      }

      if (filtered.length > 0) {
        console.log(`[claimer] ${filtered.length} redeemable winning positions found`);
      }
      return { wallet, positions: filtered, allPositions: all };
    } catch (err) {
      console.error(`[claimer] getRedeemablePositions failed:`, err.message);
      return { wallet, positions: [], allPositions: [] };
    }
  }

  /**
   * Match a trade record to a Data API position.
   * Tries: clob_token_id → conditionId → slug → neighboring windows.
   */
  _matchTradeToPosition(trade, positions) {
    // 1. Match by clob_token_id (most precise)
    if (trade.clob_token_id) {
      for (const pos of positions) {
        if (pos.asset === trade.clob_token_id) {
          console.log(`[claimer] Matched trade #${trade.id} by clob_token_id: ${trade.clob_token_id}`);
          return pos;
        }
      }
    }

    // 2. Match by conditionId
    if (trade.condition_id) {
      for (const pos of positions) {
        if (pos.conditionId === trade.condition_id) {
          console.log(`[claimer] Matched trade #${trade.id} by conditionId: ${trade.condition_id}`);
          return pos;
        }
      }
    }

    // 3. Match by slug
    const tradeSlug = trade.slug || this._buildSlug(trade);
    if (tradeSlug) {
      for (const pos of positions) {
        const posSlug = pos.slug || (pos.market && pos.market.slug);
        if (posSlug && posSlug === tradeSlug) {
          console.log(`[claimer] Matched trade #${trade.id} by slug: ${tradeSlug}`);
          return pos;
        }
      }
    }

    // 4. Try neighboring window timestamps
    if (trade.lane_id && trade.window_start) {
      const parts = trade.lane_id.split('-');
      const asset = parts[0].toLowerCase();
      const interval = parseInt(parts[1], 10);
      const offset = interval === 15 ? 900 : 300;

      for (const delta of [-offset, offset]) {
        const altTs = trade.window_start + delta;
        const altSlug = `${asset}-updown-${interval}m-${altTs}`;
        for (const pos of positions) {
          const posSlug = pos.slug || (pos.market && pos.market.slug);
          if (posSlug && posSlug === altSlug) {
            console.log(`[claimer] Matched trade #${trade.id} by neighboring slug: ${altSlug}`);
            return pos;
          }
        }
      }
    }

    return null;
  }

  _buildSlug(trade) {
    if (!trade.lane_id || !trade.window_start) return null;
    const parts = trade.lane_id.split('-');
    const asset = parts[0].toLowerCase();
    const interval = parseInt(parts[1], 10);
    return `${asset}-updown-${interval}m-${trade.window_start}`;
  }

  // ── RPC infrastructure ────────────────────────────────────────────

  async getProviderAndWallet() {
    if (this.provider && this.wallet) {
      try {
        await this.provider.getBlockNumber();
        return { provider: this.provider, wallet: this.wallet };
      } catch (err) {
        console.log(`[claimer] Cached RPC failed (${err.message}), reconnecting...`);
        this.provider = null;
        this.wallet = null;
      }
    }

    for (const url of RPC_ENDPOINTS) {
      try {
        const provider = new ethers.providers.JsonRpcProvider(url);
        await provider.getBlockNumber();
        const wallet = new ethers.Wallet(config.polygonPrivateKey, provider);
        console.log(`[claimer] Connected to RPC: ${url}`);
        this.provider = provider;
        this.wallet = wallet;
        return { provider, wallet };
      } catch (err) {
        console.log(`[claimer] RPC failed: ${url} — ${err.message}`);
      }
    }

    return null;
  }

  async getGasOverrides(provider, multiplier) {
    const MIN_PRIORITY_FEE = ethers.utils.parseUnits('30', 'gwei');
    const MIN_MAX_FEE = ethers.utils.parseUnits('150', 'gwei');

    try {
      const feeData = await provider.getFeeData();
      if (feeData && feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        const scaledPriority = feeData.maxPriorityFeePerGas.mul(Math.round(multiplier * 100)).div(100);
        const scaledMaxFee = feeData.maxFeePerGas.mul(Math.round(multiplier * 100)).div(100);

        const maxPriorityFeePerGas = scaledPriority.gt(MIN_PRIORITY_FEE) ? scaledPriority : MIN_PRIORITY_FEE;
        const maxFeePerGas = scaledMaxFee.gt(MIN_MAX_FEE) ? scaledMaxFee : MIN_MAX_FEE;

        const finalMaxFeeGwei = parseFloat(ethers.utils.formatUnits(maxFeePerGas, 'gwei')).toFixed(2);
        const finalPriorityGwei = parseFloat(ethers.utils.formatUnits(maxPriorityFeePerGas, 'gwei')).toFixed(2);
        console.log(`[claimer] Gas overrides: maxFee=${finalMaxFeeGwei}gwei, priority=${finalPriorityGwei}gwei`);

        return { maxFeePerGas, maxPriorityFeePerGas, gasLimit: 300000 };
      }
    } catch (err) {
      console.log(`[claimer] getFeeData failed (${err.message}), using fallback gas prices`);
    }

    console.log(`[claimer] Gas overrides (fallback): maxFee=150.00gwei, priority=30.00gwei`);
    return { maxFeePerGas: MIN_MAX_FEE, maxPriorityFeePerGas: MIN_PRIORITY_FEE, gasLimit: 300000 };
  }

  async clearStuckNonces(wallet) {
    const nonce = await wallet.getTransactionCount('pending');
    const confirmedNonce = await wallet.getTransactionCount('latest');

    if (nonce > confirmedNonce) {
      console.log(`[claimer] Found ${nonce - confirmedNonce} stuck pending tx(s). Clearing with nonce ${confirmedNonce}`);
      for (let i = confirmedNonce; i < nonce; i++) {
        try {
          const clearTx = await wallet.sendTransaction({
            to: wallet.address,
            value: 0,
            nonce: i,
            maxFeePerGas: ethers.utils.parseUnits('300', 'gwei'),
            maxPriorityFeePerGas: ethers.utils.parseUnits('50', 'gwei'),
            gasLimit: 21000,
          });
          console.log(`[claimer] Clearing stuck nonce ${i} — tx: ${clearTx.hash}`);
          await clearTx.wait();
          console.log(`[claimer] Nonce ${i} cleared successfully`);
        } catch (err) {
          console.error(`[claimer] Failed to clear stuck nonce ${i}: ${err.message}`);
          throw new Error(`Failed to clear stuck nonce ${i}: ${err.message}`);
        }
      }
      console.log(`[claimer] All stuck nonces cleared`);
    } else {
      console.log(`[claimer] No stuck pending txs (confirmed=${confirmedNonce}, pending=${nonce})`);
    }
  }

  // ── Core redeem helper ────────────────────────────────────────────

  /**
   * Execute redeemPositions on-chain for a given conditionId and indexSets.
   * Returns { success, txHash, error, warning }.
   */
  async _executeRedeem(conditionId, indexSets) {
    const rpc = await this.getProviderAndWallet();
    if (!rpc) {
      return { success: false, error: 'All RPC endpoints unreachable — try again later' };
    }
    const { wallet } = rpc;
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);

    let cid = conditionId;
    if (cid && !cid.startsWith('0x')) {
      cid = '0x' + cid;
    }
    cid = ethers.utils.hexZeroPad(cid, 32);

    const collateral = config.usdcAddress;
    const parent = ethers.constants.HashZero;

    console.log(`[claimer] redeemPositions: condition=${cid}, indexSets=${JSON.stringify(indexSets)}`);

    await this.clearStuckNonces(wallet);

    const gasOverrides = await this.getGasOverrides(rpc.provider, 1.5);
    const redeemNonce = await wallet.getTransactionCount('latest');
    console.log(`[claimer] Using nonce: ${redeemNonce}`);

    let tx;
    try {
      tx = await ctf.redeemPositions(collateral, parent, cid, indexSets, {
        ...gasOverrides,
        nonce: redeemNonce,
      });
    } catch (err) {
      if (err.message && err.message.includes('execution reverted')) {
        console.error(`[claimer] CRITICAL: on-chain revert — DO NOT RETRY without investigation`);
      }
      return { success: false, error: err.message };
    }

    console.log(`[claimer] Claim tx sent: ${tx.hash}`);

    let receipt;
    try {
      receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('tx.wait timeout after 30s')), 30000)),
      ]);
    } catch (err) {
      if (err.message === 'tx.wait timeout after 30s') {
        console.log(`[claimer] tx.wait timed out — will verify on next cycle. tx: ${tx.hash}`);
        return { success: false, txHash: tx.hash, timeout: true, error: 'tx.wait timed out — will verify on next cycle' };
      }
      if (err.message && err.message.includes('execution reverted')) {
        console.error(`[claimer] CRITICAL: on-chain revert — DO NOT RETRY. TX: ${tx.hash}`);
      }
      return { success: false, error: `Transaction failed (tx: ${tx.hash}): ${err.message}` };
    }

    if (!receipt || receipt.status !== 1) {
      console.log(`[claimer] Claim tx failed on-chain. TX: ${tx.hash}, status: ${receipt ? receipt.status : 'no receipt'}`);
      return { success: false, error: `Transaction reverted on-chain (tx: ${tx.hash})` };
    }

    // Receipt confirmed with status === 1 — check USDC.e balance as verification
    try {
      const rpc = await this.getProviderAndWallet();
      if (rpc) {
        const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, rpc.provider);
        const balAfter = await usdc.balanceOf(rpc.wallet.address);
        const balUsd = parseFloat(ethers.utils.formatUnits(balAfter, 6));
        console.log(`[claimer] Post-claim USDC.e balance: $${balUsd.toFixed(2)}`);
      }
    } catch (balErr) {
      console.log(`[claimer] Balance check after claim failed (non-fatal): ${balErr.message}`);
    }

    console.log(`[claimer] Claim successful — tx: ${tx.hash}`);
    return { success: true, txHash: tx.hash };
  }

  // ── Claim methods ─────────────────────────────────────────────────

  /**
   * Claim winnings for a specific trade by matching it to a Data API position.
   */
  async claimWinnings(tradeId) {
    // Force-release stale lock after 60s
    if (this.claimLock && Date.now() - this.claimLockTime > 60000) {
      console.log(`[claimer] Force-released stale claim lock after 60s`);
      this.claimLock = false;
    }

    if (this.claimLock) {
      return { success: false, error: 'Another claim is in progress' };
    }

    this.claimLock = true;
    this.claimLockTime = Date.now();
    try {
      const trade = db.getTradeById(tradeId);
      if (!trade) {
        return { success: false, error: 'Trade not found' };
      }
      if (trade.result !== 'won') {
        return { success: false, error: 'Trade is not a won trade' };
      }
      if (trade.claimed === 1) {
        return { success: false, error: 'Trade already claimed' };
      }

      // Data API is the single source of truth
      const { positions } = await this.getRedeemablePositions();

      const matched = this._matchTradeToPosition(trade, positions);
      if (!matched) {
        const available = positions.map((p) => ({
          title: p.title || p.slug || 'unknown',
          conditionId: p.conditionId,
          outcomeIndex: p.outcomeIndex,
          size: p.size,
        }));
        console.log(`[claimer] No match for trade #${tradeId}. Redeemable positions:`, JSON.stringify(available));
        return {
          success: false,
          error: 'No matching redeemable position found in Data API',
          redeemablePositions: available,
        };
      }

      console.log(`[claimer] Matched position for trade #${tradeId}: conditionId=${matched.conditionId}, outcomeIndex=${matched.outcomeIndex}, size=${matched.size}`);

      // Determine indexSets from the position's outcomeIndex
      const outcomeIndex = parseInt(matched.outcomeIndex, 10);
      const indexSets = outcomeIndex === 0 ? [1] : [2];

      if (config.dryRun) {
        db.updateTrade(tradeId, { claimed: 1, claim_tx: 'dry-run-simulated' });
        console.log(`[claimer] DRY RUN: simulated claim for trade #${tradeId}`);
        return { success: true, txHash: 'dry-run-simulated', dryRun: true };
      }

      const result = await this._executeRedeem(matched.conditionId, indexSets);

      if (result.success) {
        db.updateTrade(tradeId, { claimed: 1, claim_tx: result.txHash });
        console.log(`[claimer] Trade #${tradeId} claimed — tx: ${result.txHash}`);
      }

      return result;
    } catch (err) {
      console.error(`[claimer] Unexpected error claiming trade #${tradeId}:`, err.message);
      return { success: false, error: err.message };
    } finally {
      this.claimLock = false;
    }
  }

  /**
   * Claim all redeemable positions. Processes one at a time (respects claim lock).
   * Returns { claimed: [...], failed: [...] }.
   */
  async claimAll() {
    if (this.claimLock && Date.now() - this.claimLockTime > 60000) {
      console.log(`[claimer] Force-released stale claim lock after 60s`);
      this.claimLock = false;
    }

    if (this.claimLock) {
      return { claimed: [], failed: [{ title: 'lock', error: 'Another claim is in progress' }] };
    }

    this.claimLock = true;
    this.claimLockTime = Date.now();
    const claimed = [];
    const failed = [];

    try {
      const { positions } = await this.getRedeemablePositions();

      if (positions.length === 0) {
        console.log(`[claimer] claimAll: no redeemable positions found`);
        return { claimed: [], failed: [] };
      }

      console.log(`[claimer] claimAll: processing ${positions.length} redeemable positions`);

      // Safety filter: skip positions that are not actual winners
      const validPositions = positions.filter((p) => {
        const curPrice = parseFloat(p.curPrice);
        const size = parseFloat(p.size);
        const currentValue = parseFloat(p.currentValue || 0);
        if (curPrice !== 1 || size <= 0 || currentValue <= 0) {
          console.log(`[claimer] Skipping position ${p.title || p.slug || 'unknown'}: curPrice=${curPrice}, size=${size}, currentValue=${currentValue}`);
          return false;
        }
        return true;
      });

      if (validPositions.length < positions.length) {
        console.log(`[claimer] Filtered ${positions.length - validPositions.length} non-winner positions`);
      }

      // Notify once per claim cycle (at most every 60s) when redeemable wins exist
      if (validPositions.length > 0 && Date.now() - this._lastClaimNotifyTime >= 60000) {
        this._lastClaimNotifyTime = Date.now();
        notifications.unclaimedWinsFound(validPositions.length);
      }

      if (config.dryRun) {
        for (const pos of validPositions) {
          claimed.push({
            title: pos.title || pos.slug || 'unknown',
            conditionId: pos.conditionId,
            txHash: 'dry-run-simulated',
            shares: pos.size,
          });
        }
        console.log(`[claimer] DRY RUN: simulated claim-all for ${validPositions.length} positions`);
        return { claimed, failed };
      }

      for (const pos of validPositions) {
        const title = pos.title || pos.slug || 'unknown';
        const outcomeIndex = parseInt(pos.outcomeIndex, 10);
        const indexSets = outcomeIndex === 0 ? [1] : [2];

        try {
          // Read USDC.e balance before redeem
          let balBefore = null;
          const rpcBefore = await this.getProviderAndWallet();
          if (rpcBefore) {
            try {
              const usdcBefore = new ethers.Contract(USDC_ADDRESS, USDC_ABI, rpcBefore.provider);
              const rawBefore = await usdcBefore.balanceOf(rpcBefore.wallet.address);
              balBefore = parseFloat(ethers.utils.formatUnits(rawBefore, 6));
            } catch (balErr) {
              console.log(`[claimer] Pre-redeem balance check failed (non-fatal): ${balErr.message}`);
            }
          }

          const result = await this._executeRedeem(pos.conditionId, indexSets);
          if (result.success) {
            // Read USDC.e balance after redeem to detect ghost claims
            if (balBefore !== null) {
              try {
                const rpcAfter = await this.getProviderAndWallet();
                if (rpcAfter) {
                  const usdcAfter = new ethers.Contract(USDC_ADDRESS, USDC_ABI, rpcAfter.provider);
                  const rawAfter = await usdcAfter.balanceOf(rpcAfter.wallet.address);
                  const balAfter = parseFloat(ethers.utils.formatUnits(rawAfter, 6));
                  if (Math.abs(balAfter - balBefore) < 0.01) {
                    this.claimBlacklist.add(pos.conditionId);
                    db.setSetting('claimBlacklist', JSON.stringify([...this.claimBlacklist]));
                    console.log(`[claimer] Blacklisted conditionId ${pos.conditionId} — redeem succeeded but no balance change (already claimed)`);
                  }
                }
              } catch (balErr) {
                console.log(`[claimer] Post-redeem balance check failed (non-fatal): ${balErr.message}`);
              }
            }

            claimed.push({
              title,
              conditionId: pos.conditionId,
              txHash: result.txHash,
              shares: pos.size,
            });

            // Try to mark matching DB trades as claimed
            this._markMatchingTrades(pos, result.txHash);
          } else {
            failed.push({ title, conditionId: pos.conditionId, error: result.error });
          }
        } catch (err) {
          failed.push({ title, conditionId: pos.conditionId, error: err.message });
        }
      }

      console.log(`[claimer] claimAll complete: ${claimed.length} claimed, ${failed.length} failed`);
      return { claimed, failed };
    } catch (err) {
      console.error(`[claimer] claimAll error:`, err.message);
      return { claimed, failed: [...failed, { title: 'fatal', error: err.message }] };
    } finally {
      this.claimLock = false;
    }
  }

  /**
   * Direct claim by conditionId and outcomeIndex — no trade record needed.
   */
  async claimDirect(conditionId, outcomeIndex) {
    if (this.claimLock && Date.now() - this.claimLockTime > 60000) {
      console.log(`[claimer] Force-released stale claim lock after 60s`);
      this.claimLock = false;
    }

    if (this.claimLock) {
      return { success: false, error: 'Another claim is in progress' };
    }

    this.claimLock = true;
    this.claimLockTime = Date.now();
    try {
      if (!conditionId) {
        return { success: false, error: 'conditionId is required' };
      }

      const indexSets = outcomeIndex === 0 ? [1] : [2];
      console.log(`[claimer] Direct claim: conditionId=${conditionId}, outcomeIndex=${outcomeIndex}, indexSets=${JSON.stringify(indexSets)}`);

      if (config.dryRun) {
        return { success: true, txHash: 'dry-run-simulated', dryRun: true };
      }

      return await this._executeRedeem(conditionId, indexSets);
    } catch (err) {
      console.error(`[claimer] Direct claim error:`, err.message);
      return { success: false, error: err.message };
    } finally {
      this.claimLock = false;
    }
  }

  /**
   * After a claim-all redeem, try to mark any matching DB trades as claimed.
   */
  _markMatchingTrades(position, txHash) {
    try {
      const wonTrades = db.getTrades({ result: 'won', claimed: 0 });
      for (const trade of wonTrades) {
        const match = this._matchTradeToPosition(trade, [position]);
        if (match) {
          db.updateTrade(trade.id, { claimed: 1, claim_tx: txHash });
          console.log(`[claimer] Marked trade #${trade.id} as claimed (from claimAll)`);
        }
      }
    } catch (err) {
      console.error(`[claimer] _markMatchingTrades error:`, err.message);
    }
  }

  /**
   * Speed up a pending claim transaction by resending with higher gas.
   */
  async speedUpClaim(tradeId) {
    const trade = db.getTradeById(tradeId);
    if (!trade) {
      return { success: false, error: 'Trade not found' };
    }
    if (!trade.claim_tx || trade.claim_tx === 'dry-run-simulated') {
      return { success: false, error: 'No pending claim tx to speed up' };
    }

    const rpc = await this.getProviderAndWallet();
    if (!rpc) {
      return { success: false, error: 'All RPC endpoints unreachable — try again later' };
    }
    const { provider, wallet } = rpc;

    let pendingTx;
    try {
      pendingTx = await provider.getTransaction(trade.claim_tx);
    } catch (err) {
      return { success: false, error: `Cannot fetch pending tx: ${err.message}` };
    }

    if (!pendingTx) {
      return { success: false, error: `Tx ${trade.claim_tx} not found on-chain` };
    }
    if (pendingTx.blockNumber) {
      return { success: false, error: `Tx ${trade.claim_tx} already confirmed in block ${pendingTx.blockNumber}` };
    }

    const nonce = pendingTx.nonce;
    console.log(`[claimer] Speed-up: resending trade #${tradeId} tx with nonce ${nonce}`);

    // Get the position's conditionId from Data API
    const { positions } = await this.getRedeemablePositions();
    const matched = this._matchTradeToPosition(trade, positions);

    if (!matched) {
      return { success: false, error: 'Cannot find matching position for speed-up' };
    }

    const outcomeIndex = parseInt(matched.outcomeIndex, 10);
    const indexSets = outcomeIndex === 0 ? [1] : [2];

    let cid = matched.conditionId;
    if (cid && !cid.startsWith('0x')) {
      cid = '0x' + cid;
    }
    cid = ethers.utils.hexZeroPad(cid, 32);

    const gasOverrides = await this.getGasOverrides(provider, 2);
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
    const collateral = config.usdcAddress;
    const parent = ethers.constants.HashZero;

    let tx;
    try {
      tx = await ctf.redeemPositions(collateral, parent, cid, indexSets, {
        ...gasOverrides,
        nonce,
      });
    } catch (err) {
      console.error(`[claimer] Speed-up tx failed for trade #${tradeId}:`, err.message);
      return { success: false, error: err.message };
    }

    console.log(`[claimer] Speed-up tx sent: ${tx.hash} (replaces ${trade.claim_tx})`);
    db.updateTrade(tradeId, { claim_tx: tx.hash });

    try {
      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('tx.wait timeout after 30s')), 30000)),
      ]);

      if (!receipt || receipt.status !== 1) {
        console.log(`[claimer] Speed-up tx failed on-chain. TX: ${tx.hash}, status: ${receipt ? receipt.status : 'no receipt'}`);
        return { success: false, error: `Speed-up tx reverted on-chain (tx: ${tx.hash})` };
      }

      console.log(`[claimer] Speed-up claim confirmed for trade #${tradeId} — tx: ${tx.hash}`);
      db.updateTrade(tradeId, { claimed: 1, claim_tx: tx.hash });
      return { success: true, txHash: tx.hash };
    } catch (err) {
      if (err.message === 'tx.wait timeout after 30s') {
        console.log(`[claimer] tx.wait timed out — will verify on next cycle. tx: ${tx.hash}`);
        // Do NOT mark as claimed — leave trade as-is so the next cycle picks it up
        return { success: false, txHash: tx.hash, timeout: true, error: 'tx.wait timed out — will verify on next cycle' };
      }
      console.error(`[claimer] Speed-up receipt error for trade #${tradeId}:`, err.message);
      return { success: false, error: `Speed-up tx failed (tx: ${tx.hash}): ${err.message}` };
    }
  }

  // ── Oracle resolution — Data API as single source of truth ────────

  /**
   * Resolve pending trades using already-fetched Data API positions.
   * Called from getRedeemablePositions() to piggyback on the same API call.
   */
  resolveTradesFromOracle(allPositions) {
    try {
      const pendingTrades = db.getTrades({ result: 'pending' });
      if (pendingTrades.length === 0) return;

      for (const trade of pendingTrades) {
        if (!trade.clob_token_id) continue;

        const match = this._matchTradeToPosition(trade, allPositions);
        if (!match) continue;

        const curPrice = parseFloat(match.curPrice);

        if (curPrice === 1) {
          // This token won — trade's token is the winner
          const pnl = (trade.shares * 1.0) - trade.cost;
          db.updateTrade(trade.id, { result: 'won', pnl, close_price: null });
          db.updatePoolBalance(db.getPoolBalance() + pnl);
          console.log(`[resolver-oracle] Trade #${trade.id} ${trade.lane_id} ${trade.side} resolved via Data API: won pnl=$${pnl.toFixed(2)}`);
        } else if (curPrice === 0) {
          // This token lost — trade's token is the loser
          const pnl = -trade.cost;
          db.updateTrade(trade.id, { result: 'lost', pnl, close_price: null });
          db.updatePoolBalance(db.getPoolBalance() + pnl);

          if (trade.entry_type === 'spread_scalp') {
            spreadScalp.recordLoss();
          }

          this._checkAutoPause();
          console.log(`[resolver-oracle] Trade #${trade.id} ${trade.lane_id} ${trade.side} resolved via Data API: lost pnl=$${pnl.toFixed(2)}`);
        }
        // curPrice between 0 and 1 — oracle hasn't resolved yet, skip
      }
    } catch (err) {
      console.error('[resolver-oracle] resolveTradesFromOracle error:', err.message);
    }
  }

  /**
   * Poll the Data API for all positions and resolve pending trades.
   * curPrice === 1 → token won, curPrice === 0 → token lost.
   * curPrice between 0 and 1 → oracle hasn't resolved yet, skip.
   */
  async resolveOracleTrades() {
    const wallet = await this.getDataApiWallet();
    let allPositions;
    try {
      const resp = await axios.get(`${DATA_API_BASE}/positions?user=${wallet}`);
      allPositions = Array.isArray(resp.data) ? resp.data : [];
    } catch (err) {
      console.error('[resolver-oracle] Data API fetch failed:', err.message);
      return;
    }

    const pendingTrades = db.getTrades({ result: 'pending' });
    if (pendingTrades.length === 0) return;

    console.log(`[resolver-oracle] Checking ${pendingTrades.length} pending trade(s) against ${allPositions.length} Data API positions`);

    for (const trade of pendingTrades) {
      if (!trade.clob_token_id) continue;

      // Match by clob_token_id only — exact token match for unambiguous resolution
      const matched = allPositions.find(p => p.asset === trade.clob_token_id);
      if (!matched) continue;

      const curPrice = parseFloat(matched.curPrice);

      if (curPrice === 1) {
        // This token won
        const pnl = (trade.shares * 1.0) - trade.cost;
        db.updateTrade(trade.id, { result: 'won', pnl });

        const poolBalance = db.getPoolBalance();
        db.updatePoolBalance(poolBalance + pnl);

        notifications.tradeResult({ ...trade, result: 'won', pnl }, db.getPoolBalance());
        console.log(`[resolver-oracle] Trade #${trade.id} ${trade.lane_id} resolved via Data API: won pnl=$${pnl.toFixed(2)}`);
      } else if (curPrice === 0) {
        // This token lost
        const pnl = -trade.cost;
        db.updateTrade(trade.id, { result: 'lost', pnl });

        const poolBalance = db.getPoolBalance();
        db.updatePoolBalance(poolBalance + pnl);

        if (trade.entry_type === 'spread_scalp') {
          spreadScalp.recordLoss();
        }

        notifications.tradeResult({ ...trade, result: 'lost', pnl }, db.getPoolBalance());
        this._checkAutoPause();
        console.log(`[resolver-oracle] Trade #${trade.id} ${trade.lane_id} resolved via Data API: lost pnl=$${pnl.toFixed(2)}`);
      }
      // curPrice between 0 and 1 — oracle hasn't resolved yet, skip
    }
  }

  _checkAutoPause() {
    const raw = db.getDb();
    const last3 = raw.prepare("SELECT result FROM trades WHERE result IN ('won','lost') ORDER BY id DESC LIMIT 3").all();
    if (last3.length === 3 && last3.every(t => t.result === 'lost')) {
      db.setSetting('paused', 'true');
      global.botPaused = true;
      console.log('[bot] \u26A0 AUTO-PAUSED: 3 consecutive losses detected');
      notifications.send('\u26A0 AUTO-PAUSED: 3 consecutive losses. Review and resume manually.');
    }
  }

  startOracleResolver() {
    this._oracleTimer = setInterval(() => {
      this.resolveOracleTrades().catch(err => {
        console.error('[resolver-oracle] Error:', err.message);
      });
    }, 60000);
    console.log('[resolver-oracle] Oracle trade resolver started (60s interval)');
  }

  close() {
    if (this._oracleTimer) {
      clearInterval(this._oracleTimer);
      this._oracleTimer = null;
    }
  }
}

const claimer = new Claimer();

module.exports = { Claimer, claimer };
