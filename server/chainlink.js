const { ethers } = require('ethers');

const FEED_ADDRESSES = {
  BTC: '0xc907E116054Ad103354f2D350FD2514433D57F6f',
  ETH: '0xF9680D99D6C9589e2a93a78A04A279e509205945',
};

const ABI = ['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'];

const RPC_ENDPOINTS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.llamarpc.com',
  'https://poly-rpc.gateway.pokt.network',
];

let cachedProvider = null;
const contractCache = new Map();

async function getProvider() {
  if (cachedProvider) return cachedProvider;

  for (const url of RPC_ENDPOINTS) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(url);
      await provider.getBlockNumber(); // test connection
      cachedProvider = provider;
      console.log(`[chainlink] Connected to Polygon RPC: ${url}`);
      return provider;
    } catch (err) {
      console.error(`[chainlink] RPC failed ${url}: ${err.message}`);
    }
  }

  console.error('[chainlink] All RPC endpoints failed');
  return null;
}

function getContract(asset, provider) {
  if (contractCache.has(asset)) return contractCache.get(asset);

  const address = FEED_ADDRESSES[asset];
  if (!address) return null;

  const contract = new ethers.Contract(address, ABI, provider);
  contractCache.set(asset, contract);
  return contract;
}

async function getChainlinkPrice(asset) {
  try {
    const provider = await getProvider();
    if (!provider) return null;

    const contract = getContract(asset, provider);
    if (!contract) return null;

    const [, answer] = await contract.latestRoundData();
    const price = parseFloat(ethers.utils.formatUnits(answer, 8));
    return price;
  } catch (err) {
    console.error(`[chainlink] Error reading ${asset} price:`, err.message);
    // Reset cached provider so next call tries fresh
    cachedProvider = null;
    contractCache.clear();
    return null;
  }
}

async function captureChainlinkOpen(asset) {
  const price = await getChainlinkPrice(asset);
  if (price != null) {
    console.log(`[chainlink] ${asset} oracle price: $${price}`);
  }
  return price;
}

module.exports = { getChainlinkPrice, captureChainlinkOpen };
