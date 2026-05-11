import React, { createContext, useContext, useState, useCallback } from 'react';
import { setToken, getToken } from '../lib/api.js';

const AgentContext = createContext(null);

export function AgentProvider({ children }) {
  const [agent, setAgentState] = useState(null);
  const [jwt,   setJwtState]   = useState(() => getToken());

  const setAgent = useCallback((a) => setAgentState(a), []);

  const setJwt = useCallback((t) => {
    setToken(t);
    setJwtState(t);
  }, []);

  // Clear only the JWT session (agent record stays in DB, user can reconnect via passkey)
  const disconnectSession = useCallback(() => {
    setAgentState(null);
    setToken(null);
    setJwtState(null);
  }, []);

  // Clear JWT + agent state (used after deletion)
  const clearAgent = useCallback(() => {
    setAgentState(null);
    setToken(null);
    setJwtState(null);
  }, []);

  return (
    <AgentContext.Provider value={{ agent, setAgent, jwt, setJwt, clearAgent, disconnectSession, isAuthenticated: !!jwt }}>
      {children}
    </AgentContext.Provider>
  );
}

export function useAgent() {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgent must be used inside AgentProvider');
  return ctx;
}
