/**
 * Keep one-time wallet secrets out of shared React agent state.
 * The creation response exposes privateKey only for the confirmation screen.
 */
export function agentForClientState(created) {
  const agent = created?.agent ?? created;
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
    return agent;
  }
  const {
    privateKey,
    private_key,
    private_key_encrypted,
    privateKeyEncrypted,
    ...safeAgent
  } = agent;
  return safeAgent;
}
