/**
 * QR Scanner helpers — camera-based QR code reading + EIP-681 URI parsing.
 * Only Arc Testnet (Chain ID 5042002) is accepted.
 */
import { BrowserQRCodeReader, BrowserCodeReader } from '@zxing/browser';
import { getAddress } from 'ethers';
import { ARC_TESTNET_ID, CHAINS } from './chains.js';

const ARC_CHAIN_ID = ARC_TESTNET_ID;
const USDC_ADDRESS = CHAINS['Arc Testnet']?.usdcAddress || '0x3600000000000000000000000000000000000000';
const EXPECTED_TOKEN_ADDRESS = getAddress(USDC_ADDRESS);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const USDC_DECIMALS = 6;
const EXPECTED_QUERY_KEYS = new Set(['address', 'uint256']);

let reader     = null;
let controls   = null; // zxing scan controls (has .stop())

/**
 * Start QR scanning from the given <video> element.
 * Calls onResult({ uri, recipient, amountUsdc, chainId, tokenAddress }) when a valid QR is found.
 * Calls onError(err) on camera / parse errors.
 *
 * @param {HTMLVideoElement} videoElement
 * @param {(result: object) => void} onResult
 * @param {(err: Error) => void} [onError]
 */
export async function startScan(videoElement, onResult, onError) {
  reader = new BrowserQRCodeReader();

  try {
    controls = await reader.decodeFromVideoDevice(undefined, videoElement, (result, err) => {
      if (result) {
        try {
          const parsed = parsePaymentURI(result.getText());
          onResult(parsed);
        } catch (parseErr) {
          if (onError) onError(parseErr);
        }
      }
      // Ignore transient "not found" errors — zxing fires these every frame
    });
  } catch (err) {
    if (onError) onError(err);
    throw err;
  }
}

/**
 * Stop an active QR scan and release the camera.
 */
export function stopScan() {
  if (controls) {
    try { controls.stop(); } catch { /* ignore */ }
    controls = null;
  }
  reader = null;
}

/**
 * Parse an EIP-681 USDC payment URI.
 * Expected format: ethereum:<arcUsdcAddr>@5042002/transfer?address=<recipient>&uint256=<amountWei>
 *
 * @param {string} uri
 * @returns {{ recipient: string, amountUsdc: number, chainId: number, raw: string, tokenAddress: string }}
 * @throws {Error} if URI is invalid or chainId !== ARC_CHAIN_ID
 */
export function parsePaymentURI(uri) {
  if (!uri || !uri.startsWith('ethereum:')) {
    throw new Error('Invalid QR code — not an EIP-681 payment URI');
  }

  // ethereum:<tokenAddr>@<chainId>/transfer?address=<recipient>&uint256=<amountWei>
  const withoutScheme = uri.slice('ethereum:'.length);

  const atIdx = withoutScheme.indexOf('@');
  if (atIdx === -1) throw new Error('Invalid URI — missing chain ID (@<chainId>)');

  const tokenAddressRaw = withoutScheme.slice(0, atIdx);
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddressRaw)) {
    throw new Error('Invalid URI — unsupported payment token address');
  }

  const tokenAddress = getAddress(tokenAddressRaw);
  if (tokenAddress !== EXPECTED_TOKEN_ADDRESS) {
    throw new Error('Invalid URI — only Arc Testnet USDC transfer requests are supported');
  }

  // Extract chainId
  const slashIdx = withoutScheme.indexOf('/', atIdx);
  if (slashIdx === -1) throw new Error('Invalid URI — missing function path (/transfer)');

  const functionPath = withoutScheme.slice(slashIdx, withoutScheme.indexOf('?', slashIdx) === -1 ? undefined : withoutScheme.indexOf('?', slashIdx));
  if (functionPath !== '/transfer') {
    throw new Error('Invalid URI — only ERC-20 transfer requests are supported');
  }

  const chainId = parseInt(withoutScheme.slice(atIdx + 1, slashIdx), 10);
  if (chainId !== ARC_CHAIN_ID) {
    throw new Error(`Wrong network — this QR is for chain ${chainId}, but only Arc Testnet (${ARC_CHAIN_ID}) is supported`);
  }

  // Parse query params
  const qIdx = withoutScheme.indexOf('?');
  if (qIdx === -1) throw new Error('Invalid URI — no query parameters');

  const params = new URLSearchParams(withoutScheme.slice(qIdx + 1));
  const recipient  = params.get('address');
  const amountWei  = params.get('uint256');

  for (const [key] of params.entries()) {
    if (!EXPECTED_QUERY_KEYS.has(key)) {
      throw new Error(`Invalid URI — unsupported query parameter: ${key}`);
    }
  }

  if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    throw new Error('Invalid URI — missing or malformed recipient address');
  }

  let checksumRecipient;
  try {
    checksumRecipient = getAddress(recipient);
  } catch {
    throw new Error('Invalid URI — recipient address checksum is invalid');
  }

  if (checksumRecipient !== recipient) {
    throw new Error('Invalid URI — recipient address must use EIP-55 checksum formatting');
  }

  if (checksumRecipient === ZERO_ADDRESS) {
    throw new Error('Invalid URI — recipient is the zero address');
  }

  if (!amountWei || !/^\d+$/.test(amountWei) || amountWei === '0') {
    throw new Error('Invalid URI — missing or zero amount');
  }

  const amountUsdc = Number(BigInt(amountWei)) / 10 ** USDC_DECIMALS;
  if (amountUsdc <= 0) throw new Error('Invalid URI — amount must be positive');

  if (!Number.isFinite(amountUsdc)) {
    throw new Error('Invalid URI — amount is out of range');
  }

  return { recipient: checksumRecipient, amountUsdc, chainId, raw: uri, tokenAddress };
}
