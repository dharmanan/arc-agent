import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Terminal, CheckCircle2, Loader2 } from 'lucide-react';

const logs = [
  { text: "Initializing Agent Core...", delay: 400 },
  { text: "Establishing secure connection to decentralized exchanges...", delay: 800 },
  { text: "Connecting: Uniswap v3, Sushiswap, Curve Finance", delay: 600 },
  { text: "Scanning liquidity pools across all integrated protocols...", delay: 1200 },
  { text: "Targeting high-volume pairs: USDC/crvUSD, USDC/crvBTC...", delay: 900 },
  { text: "Analyzing cross-exchange order books in real-time...", delay: 1500 },
  { text: "[ALERT] High volatility detected in USDC/crvBTC pool (Curve)", delay: 800, isAlert: true },
  { text: "Calculating optimal MEV-resistant routing paths...", delay: 1000 },
  { text: "Arbitrage opportunity identified: +1.24% edge", delay: 500, isSuccess: true },
  { text: "Simulating execution with flash loans to prevent capital lockup...", delay: 1100 },
  { text: "Simulation successful. Flash loan secured.", delay: 600 },
  { text: "Executing multi-hop trades...", delay: 1400 },
  { text: "Trades executed successfully.", delay: 400 },
  { text: "Arbitrage profit captured: +1.22% (after slippage & gas)", delay: 500, isSuccess: true },
  { text: "Closing state channels. Returning to standby.", delay: 1000 }
];

export function DemoModal({ isOpen, onClose }) {
  const [currentLogIndex, setCurrentLogIndex] = useState(0);
  const [displayedLogs, setDisplayedLogs] = useState([]);
  const [isFinished, setIsFinished] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!isOpen) {
      setCurrentLogIndex(0);
      setDisplayedLogs([]);
      setIsFinished(false);
      return;
    }

    if (currentLogIndex < logs.length) {
      const currentLog = logs[currentLogIndex];
      const timer = setTimeout(() => {
        setDisplayedLogs(prev => [...prev, currentLog]);
        setCurrentLogIndex(prev => prev + 1);
      }, currentLog.delay);
      return () => clearTimeout(timer);
    } else {
      setIsFinished(true);
    }
  }, [isOpen, currentLogIndex]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [displayedLogs]);

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-[#0F1612]/80 backdrop-blur-md"
            onClick={onClose}
          />
          <motion.div
             initial={{ opacity: 0, scale: 0.95, y: 20 }}
             animate={{ opacity: 1, scale: 1, y: 0 }}
             exit={{ opacity: 0, scale: 0.95, y: 20 }}
             className="relative w-full max-w-2xl bg-[#030604] border border-[#2E5C36]/50 shadow-[0_0_50px_rgba(46,92,54,0.15)] rounded-lg overflow-hidden flex flex-col"
          >
             <div className="flex items-center justify-between px-5 py-4 border-b border-[#2E5C36]/30 bg-[#0A100C]">
                <div className="flex items-center gap-3">
                   <Terminal className="w-5 h-5 text-[#4CAF50]" />
                   <span className="text-[#4CAF50] font-mono font-semibold tracking-[0.2em] text-sm mt-1">AGENT_TERMINAL</span>
                </div>
                <button onClick={onClose} className="text-[#4CAF50]/60 hover:text-[#4CAF50] transition-colors">
                  <X className="w-5 h-5" />
                </button>
             </div>
             
             <div ref={scrollRef} className="p-6 h-[400px] overflow-y-auto font-mono text-sm flex flex-col gap-3 scroll-smooth">
                {displayedLogs.map((log, index) => (
                  <motion.div 
                    key={index}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    className={`flex items-start gap-3 ${log.isAlert ? 'text-amber-400' : log.isSuccess ? 'text-emerald-400 font-bold' : 'text-[#4CAF50]'}`}
                  >
                    <span className="opacity-50 mt-0.5">{`>`}</span>
                    <span className="leading-relaxed">{log.text}</span>
                  </motion.div>
                ))}
                {!isFinished && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex items-center gap-2 text-[#4CAF50]/60 mt-2"
                  >
                     <Loader2 className="w-4 h-4 animate-spin" />
                     <span className="animate-pulse">Processing...</span>
                  </motion.div>
                )}
             </div>
             
             {isFinished && (
               <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-[#0A100C] p-5 border-t border-[#2E5C36]/30 flex items-center justify-between"
               >
                  <div className="flex items-center gap-2 text-emerald-400 font-bold tracking-wide">
                     <CheckCircle2 className="w-5 h-5" />
                     <span className="mt-0.5">CYCLE COMPLETE</span>
                  </div>
                  <button onClick={onClose} className="px-6 py-2 bg-[#2E5C36]/20 border border-[#2E5C36]/50 text-[#4CAF50] rounded font-mono font-bold tracking-widest text-xs hover:bg-[#2E5C36]/40 transition-colors uppercase">
                    Return
                  </button>
               </motion.div>
             )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}