export function getOnchainReputationLabelValue(onchain = {}) {
  switch (onchain?.status) {
    case 'live':
      return 'On-chain live';
    case 'cached':
      return 'On-chain cached';
    case 'identity_required':
      return 'Identity required';
    case 'token_missing':
      return 'Token missing';
    case 'read_error':
      return 'Read error';
    default:
      return 'Local only';
  }
}

export function getOnchainReputationMessageValue(onchain = {}, formatTimestamp = (value) => value) {
  switch (onchain?.status) {
    case 'live':
      return 'Reputation writes are mirrored on-chain and can be read back from the registry.';
    case 'cached':
      return onchain?.cachedAt
        ? `Last confirmed on-chain score from ${formatTimestamp(onchain.cachedAt)}. Live read is temporarily unavailable.`
        : 'Last confirmed on-chain score is shown while live read is temporarily unavailable.';
    case 'identity_required':
      return 'Register the agent identity first so reputation can be attached to an ERC-8004 token.';
    case 'token_missing':
      return 'Identity is marked registered, but no ERC-8004 token id was found on the agent record.';
    case 'read_error':
      return 'The registry address is configured, but the current on-chain score could not be read.';
    default:
      return 'Events are still counted locally even while the registry is not configured.';
  }
}
