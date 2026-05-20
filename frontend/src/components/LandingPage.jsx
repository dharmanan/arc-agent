import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import Spline from '@splinetool/react-spline';
import { LiquidButton } from './ui/liquid-glass-button';
import { DemoModal } from './DemoModal';

const MatrixRain = () => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = canvas.offsetWidth;
    let height = canvas.offsetHeight;
    canvas.width = width;
    canvas.height = height;

    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789アァカサタナハマヤャラワガザダバパイィキシチニヒミリヰギジヂビピウゥクスツヌフムユュルグズブヅプエェケセテネヘメレゲゼデベペオォコソトノホモヨョロゴゾドボポヴッン';

    const fontSize = 16;
    const columns = width / fontSize;
    const drops = Array(Math.floor(columns)).fill(1);

    const draw = () => {
      ctx.fillStyle = 'rgba(245, 248, 246, 0.05)'; 
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = '#22c55e';
      ctx.font = fontSize + 'px monospace';

      for (let i = 0; i < drops.length; i++) {
        const text = alphabet.charAt(Math.floor(Math.random() * alphabet.length));
        ctx.fillText(text, i * fontSize, drops[i] * fontSize);

        if (drops[i] * fontSize > height && Math.random() > 0.975) {
          drops[i] = 0;
        }
        drops[i]++;
      }
    };

    const interval = setInterval(draw, 33);
    const handleResize = () => {
      width = canvas.offsetWidth;
      height = canvas.offsetHeight;
      canvas.width = width;
      canvas.height = height;
      drops.length = Math.floor(width / fontSize);
      drops.fill(1);
    };
    window.addEventListener('resize', handleResize);
    return () => {
      clearInterval(interval);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full opacity-60 pointer-events-none z-0" />;
};

const MatrixReveal = ({ text, delay = 0, speed = 40, className = "" }) => {
  const [displayText, setDisplayText] = useState("");

  useEffect(() => {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*<>";
    let interval;
    let timeout;

    timeout = setTimeout(() => {
      let iteration = 0;
      interval = setInterval(() => {
        setDisplayText(
          text
            .split("")
            .map((letter, index) => {
              if(letter === " ") return " ";
              if(index < iteration) return letter;
              return letters[Math.floor(Math.random() * letters.length)];
            })
            .join("")
        );
        if(iteration >= text.length) {
          clearInterval(interval);
          setDisplayText(text);
        }
        iteration += 1 / 3;
      }, speed);
    }, delay);

    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [text, delay, speed]);

  return <span className={className}>{displayText || text.replace(/./g, "\u00A0")}</span>;
};

const benefitList = [
  "No coding knowledge required.",
  "Deploy agents that execute and trade for you.",
  "Agents collaborate to find the best market strategies.",
  "Your digital workforce never sleeps."
];

export default function LandingPage({ onEnterApp }) {
  const [status, setStatus] = useState('idle');
  const [isDemoOpen, setIsDemoOpen] = useState(false);

  const handleEnter = () => {
    setStatus('shaking');
    setTimeout(() => {
      setStatus('collapsing');
    }, 1200); 
    setTimeout(() => {
      onEnterApp('dashboard');
    }, 2800); 
  };

  return (
    <motion.div 
      animate={status}
      variants={{
        idle: { scale: 1, filter: "blur(0px)", opacity: 1, rotate: 0, x: 0, y: 0 },
        shaking: {
          x: [0, -30, 30, -25, 25, -15, 15, -10, 10, -5, 5, 0],
          y: [0, 30, -30, 20, -20, 15, -15, 10, -10, 5, -5, 0],
          transition: { duration: 1.2, ease: "easeInOut" }
        },
        collapsing: { 
          scale: 0, 
          filter: "blur(20px)", 
          opacity: 0, 
          rotate: 1080,
          transition: { duration: 1.5, ease: "easeIn" } 
        }
      }}
      className="min-h-screen bg-[#F5F8F6] text-[#1E2922] font-mono flex flex-col lg:flex-row relative selection:bg-[#347A3D] selection:text-white overflow-hidden origin-center"
    >
      
      {/* Background Decor & Matrix Effect */}
      <div className="absolute top-0 left-0 w-full h-full z-0 overflow-hidden opacity-50 mix-blend-darken pointer-events-none">
         <MatrixRain />
         <div className="absolute inset-0 bg-gradient-to-t from-[#F5F8F6] via-transparent to-[#F5F8F6] z-10" />
      </div>

      <div className="absolute top-0 right-0 w-[800px] h-[800px] bg-gradient-to-b from-[#E6EFE7] to-transparent rounded-full blur-3xl opacity-60 -translate-y-1/3 translate-x-1/3 pointer-events-none z-0" />

      {/* Main Content - Left Side */}
      <main className="w-full lg:w-1/2 flex flex-col justify-center px-6 md:px-12 lg:pl-16 lg:pr-4 py-16 lg:py-0 min-h-[100vh] z-10 relative items-center lg:items-end xl:pr-12">
        <div className="max-w-xl mx-auto lg:mr-0 xl:mr-8 w-full">
          
          <motion.div 
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8, delay: 0.5 }}
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#347A3D]/30 bg-[#347A3D]/10 mb-6"
          >
            <span className="w-2.5 h-2.5 rounded-full bg-[#347A3D] animate-pulse"></span>
            <span className="text-xs font-bold text-[#347A3D] tracking-widest uppercase mt-0.5">NETWORK LIVE</span>
          </motion.div>

          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 1 }}
            className="text-5xl md:text-6xl lg:text-[4rem] xl:text-[4.5rem] font-extrabold tracking-tighter leading-[1.05] mb-8 text-[#1A261E] font-sans uppercase"
          >
            <div className="block text-[#1A261E]">NO CODE.</div>
            <div className="block mt-2 text-[#347A3D] text-[3rem] md:text-[4.5rem] lg:text-[5rem] xl:text-[6rem] leading-[0.9] glitch-text-wrapper relative inline-block">
              <span className="relative z-10 glitch-main">JUST ARC MACHINA.</span>
              <span className="glitch-layer glitch-layer-1">JUST ARC MACHINA.</span>
              <span className="glitch-layer glitch-layer-2">JUST ARC MACHINA.</span>
            </div>
          </motion.div>

          <div className="text-lg text-[#5A6E60] mb-8 max-w-lg leading-relaxed font-semibold min-h-[90px]">
            <MatrixReveal 
              text="Arc Machina lets anyone join the agent economy. Simply build your team, and your autonomous workforce will collaborate and execute trades for you day and night." 
              delay={1200} 
              speed={20}
            />
          </div>
          
          <div className="space-y-4 mb-12 max-w-lg relative z-20">
            {benefitList.map((item, i) => (
               <div key={i} className="flex items-start gap-4">
                 <motion.div
                   initial={{ opacity: 0, scale: 0 }}
                   animate={{ opacity: 1, scale: 1 }}
                   transition={{ delay: 2000 + i * 400 }}
                   className="pt-0.5"
                 >
                   <span className="text-[#347A3D] font-black text-lg leading-none shrink-0">&gt;</span>
                 </motion.div>
                 <MatrixReveal text={item} delay={2000 + i * 400} speed={25} className="font-bold text-[15px] tracking-tight bg-white/50 backdrop-blur-sm px-2 rounded -ml-1 text-[#1A261E] shadow-sm uppercase leading-relaxed" />
               </div>
            ))}
          </div>

          {/* Action */}
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 3.5 }}
            className="flex flex-col sm:flex-row justify-center md:justify-start md:ml-20 w-full relative z-30"
          >
            <LiquidButton onClick={handleEnter} className="w-full sm:w-auto h-14 px-10 text-lg group">
              <span className="relative z-10 transition-colors uppercase leading-none">ENTER THE FUTURE</span>
            </LiquidButton>
          </motion.div>

        </div>
      </main>

      {/* 3D Spline Canvas Container - Right Side */}
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 2, delay: 1 }}
        className="w-full h-[60vh] lg:h-screen lg:w-1/2 flex flex-col justify-center items-center relative z-0 pointer-events-none"
      >
        <div 
          className="absolute inset-0 w-full h-full mix-blend-darken relative z-10 transition-all duration-1000 pointer-events-auto"
          style={{ 
            filter: 'invert(1) grayscale(1) brightness(0.75) contrast(1.8)',
            WebkitFilter: 'invert(1) grayscale(1) brightness(0.75) contrast(1.8)'
          }}
        >
          <Spline scene="https://prod.spline.design/kZDDjO5HuC9GJUM2/scene.splinecode" />
        </div>
        
        {/* Overlaid Try Button */}
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1, delay: 5 }}
          className="absolute top-[48%] lg:top-[48%] z-30 pointer-events-auto"
        >
          <LiquidButton onClick={() => setIsDemoOpen(true)} size="lg" className="px-8 py-3 font-bold tracking-widest shadow-xl text-[#347A3D]">
            <span className="relative z-10">TRY ME</span>
          </LiquidButton>
        </motion.div>
      </motion.div>

      <DemoModal isOpen={isDemoOpen} onClose={() => setIsDemoOpen(false)} />

    </motion.div>
  );
}