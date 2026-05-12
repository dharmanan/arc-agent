/**
 * QR Payment helpers — EIP-681 URI generation + QR code rendering.
 * Only Arc Testnet (Chain ID 5042002) is supported.
 */
import QRCode from 'qrcode';

const ARC_CHAIN_ID   = 5042002;
const USDC_ADDRESS   = '0x3600000000000000000000000000000000000000';
const USDC_DECIMALS  = 6;

/**
 * Build an EIP-681 payment request URI.
 * Format: ethereum:<tokenAddr>@<chainId>/transfer?address=<recipient>&uint256=<amountWei>
 *
 * @param {string} recipientAddress  — 0x… wallet address
 * @param {number|string} amountUsdc — amount in USDC (e.g. 10.50)
 * @returns {string} EIP-681 URI
 */
export function buildPaymentURI(recipientAddress, amountUsdc) {
  if (!recipientAddress || !/^0x[0-9a-fA-F]{40}$/.test(recipientAddress)) {
    throw new Error('Invalid recipient address');
  }
  const amount = parseFloat(amountUsdc);
  if (!amount || amount <= 0) throw new Error('Amount must be greater than zero');

  // Convert USDC to raw uint256 (6 decimals) — use BigInt to avoid float precision loss
  const amountWei = BigInt(Math.round(amount * 10 ** USDC_DECIMALS));

  return `ethereum:${USDC_ADDRESS}@${ARC_CHAIN_ID}/transfer?address=${recipientAddress}&uint256=${amountWei}`;
}

/**
 * Render an EIP-681 URI as a base64-encoded PNG data URL.
 *
 * @param {string} uri
 * @returns {Promise<string>} data:image/png;base64,...
 */
export async function generateQRDataURL(uri) {
  return QRCode.toDataURL(uri, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 280,
    color: { dark: '#0f172a', light: '#ffffff' },
  });
}
