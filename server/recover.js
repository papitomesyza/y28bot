#!/usr/bin/env node
'use strict';

require('dotenv').config();

const axios = require('axios');
const { ethers } = require('ethers');
const readline = require('readline');

const RPC_ENDPOINTS = [
  'https://polygon-rpc.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon-bor-rpc.publicnode.com',
];

let currentRpcIndex = 0;

const PRIVATE_KEY = process.env.POLYGON_PRIVATE_KEY;
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const PARENT_COLLECTION_ID = '0x0000000000000000000000000000000000000000000000000000000000000000';

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
];

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
];

function createProvider() {
  const url = RPC_ENDPOINTS[currentRpcIndex];
  console.log(`[recover] Using RPC: ${url}`);
  return new ethers.providers.JsonRpcProvider(url);
}

function switchRpc() {
  if (currentRpcIndex + 1 >= RPC_ENDPOINTS.length) return false;
  currentRpcIndex++;
  return true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function checkResolution(market) {
  const resolved = market.resolved;
  const isResolved = market.is_resolved;
  const closed = market.closed;
  const active = market.active;

  return resolved === true || resolved === 'true' ||
         isResolved === true || isResolved === 'true' ||
         (closed === true && active === false);
}

function deduplicate(markets) {
  const seen = new Set();
  const result = [];
  for (const m of markets) {
    const cid = m.conditionId || m.condition_id;
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    result.push(m);
  }
  return result;
}

async function fetchPage(baseParams, label) {
  try {
    const resp = await axios.get('https://gamma-api.polymarket.com/markets', { params: baseParams });
    const data = Array.isArray(resp.data) ? resp.data : [];
    console.log(`[recover] Gamma returned ${data.length} markets (${label})`);
    return data;
  } catch (err) {
    console.error(`[recover] Failed to fetch markets (${label}): ${err.message}`);
    return [];
  }
}

async function main() {
  if (!PRIVATE_KEY) {
    console.error('[recover] POLYGON_PRIVATE_KEY not set. Create a .env file or set it in your environment.');
    process.exit(1);
  }

  let provider = createProvider();
  let wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  let ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
  let usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

  function rebuildContracts() {
    provider = createProvider();
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
    usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
  }

  console.log(`[recover] Wallet: ${wallet.address}`);
  console.log('[recover] Fetching closed markets from Gamma API...');

  let allMarkets = [];

  // First page of both queries
  const closedData = await fetchPage({ closed: true, limit: 100 }, 'closed=true');
  const inactiveData = await fetchPage({ active: false, limit: 100 }, 'active=false');
  allMarkets.push(...closedData, ...inactiveData);

  // Deduplicate and check if we found shares in the first batch
  let markets = deduplicate(allMarkets);
  console.log(`[recover] ${markets.length} unique markets after deduplication`);
  console.log(`[recover] Checking ${markets.length} closed markets for unclaimed shares...`);

  let foundAny = false;
  let redeemed = 0;

  foundAny = await scanMarkets(markets, () => ctf, () => wallet, () => usdc, checkResolution, ask, (n) => { redeemed += n; }, rebuildContracts);

  // If nothing found in first 100, paginate deeper
  if (!foundAny) {
    console.log('[recover] No shares found in first batch. Paginating to check older markets...');

    for (let offset = 100; offset <= 500; offset += 100) {
      const moreAll = [];
      const moreClosed = await fetchPage({ closed: true, limit: 100, offset }, `closed=true offset=${offset}`);
      const moreInactive = await fetchPage({ active: false, limit: 100, offset }, `active=false offset=${offset}`);
      moreAll.push(...moreClosed, ...moreInactive);

      // Stop paginating if API returned nothing
      if (moreClosed.length === 0 && moreInactive.length === 0) {
        console.log(`[recover] No more markets at offset=${offset}, stopping pagination.`);
        break;
      }

      const moreMarkets = deduplicate(moreAll);
      console.log(`[recover] Checking ${moreMarkets.length} closed markets for unclaimed shares (offset=${offset})...`);

      const found = await scanMarkets(moreMarkets, () => ctf, () => wallet, () => usdc, checkResolution, ask, (n) => { redeemed += n; }, rebuildContracts);
      if (found) {
        foundAny = true;
        break;
      }
    }
  }

  if (!foundAny) {
    console.log('[recover] No unclaimed shares found across all pages.');
  }

  // Final USDC.e balance
  try {
    const finalBalance = await usdc.balanceOf(wallet.address);
    const formatted = ethers.utils.formatUnits(finalBalance, 6);
    console.log(`\n[recover] Final USDC.e balance: $${formatted}`);
  } catch (err) {
    if (err.code === 'NETWORK_ERROR' && switchRpc()) {
      rebuildContracts();
      try {
        const finalBalance = await usdc.balanceOf(wallet.address);
        const formatted = ethers.utils.formatUnits(finalBalance, 6);
        console.log(`\n[recover] Final USDC.e balance: $${formatted}`);
      } catch (retryErr) {
        console.error(`[recover] Failed to check final USDC.e balance: ${retryErr.message}`);
      }
    } else {
      console.error(`[recover] Failed to check final USDC.e balance: ${err.message}`);
    }
  }

  console.log(`[recover] Done. Redeemed ${redeemed} position(s).`);
}

async function balanceOfWithFallback(ctfGetter, walletGetter, tokenId, rebuildContracts) {
  try {
    return await ctfGetter().balanceOf(walletGetter().address, tokenId);
  } catch (err) {
    if (err.code === 'NETWORK_ERROR' && switchRpc()) {
      rebuildContracts();
      return await ctfGetter().balanceOf(walletGetter().address, tokenId);
    }
    throw err;
  }
}

async function scanMarkets(markets, ctfGetter, walletGetter, usdcGetter, checkResolution, ask, onRedeem, rebuildContracts) {
  let foundAny = false;

  for (const market of markets) {
    try {
      const conditionId = market.conditionId || market.condition_id;
      if (!conditionId) continue;

      let tokenIds;
      try {
        const raw = market.clobTokenIds || market.clob_token_ids;
        tokenIds = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (err) {
        continue;
      }

      if (!Array.isArray(tokenIds) || tokenIds.length === 0) continue;

      // Check balance for each token ID — skip silently if 0
      const tokensWithBalance = [];
      for (const tokenId of tokenIds) {
        try {
          await sleep(200);
          const balance = await balanceOfWithFallback(ctfGetter, walletGetter, tokenId, rebuildContracts);
          if (!balance.isZero()) {
            const formatted = ethers.utils.formatUnits(balance, 6);
            console.log(`[recover] Found ${formatted} shares of token ${tokenId} on market: ${market.question}`);
            tokensWithBalance.push({ tokenId, balance, formatted });
          }
        } catch (err) {
          console.error(`[recover] Balance check failed for token ${tokenId}: ${err.message}`);
        }
      }

      if (tokensWithBalance.length === 0) continue;

      foundAny = true;

      // Check resolution
      if (!checkResolution(market)) {
        console.log('[recover] Market not yet resolved, skipping redemption.');
        continue;
      }

      console.log('[recover] Market is resolved.');

      for (const { tokenId, formatted } of tokensWithBalance) {
        const answer = await ask(`Redeem ${formatted} shares from "${market.question}"? (y/n): `);

        if (answer !== 'y') {
          console.log('[recover] Skipped.');
          continue;
        }

        try {
          console.log(`[recover] Sending redeemPositions tx for conditionId ${conditionId}...`);
          const tx = await ctfGetter().redeemPositions(
            USDC_ADDRESS,
            PARENT_COLLECTION_ID,
            conditionId,
            [1, 2]
          );
          console.log(`[recover] TX sent: ${tx.hash}`);
          const receipt = await tx.wait();
          if (receipt.status === 1) {
            console.log(`[recover] TX confirmed: ${tx.hash}`);
            onRedeem(1);
          } else {
            console.error(`[recover] TX reverted on-chain: ${tx.hash}`);
          }
        } catch (err) {
          console.error(`[recover] Redemption failed: ${err.message}`);
        }

        // Only one redeem per conditionId needed (both indexSets sent at once)
        break;
      }
    } catch (err) {
      console.error(`[recover] Error processing market "${market.question}": ${err.message}`);
    }
  }

  return foundAny;
}

main().catch((err) => {
  console.error('[recover] Fatal error:', err.message);
  process.exit(1);
});
