import React, { useState } from 'react';
import { motion } from 'motion/react';

interface KineticCubeClusterProps {
  compact?: boolean;
}

interface IsometricBlockProps {
  label: string;
  sublabel?: string;
  dark?: boolean;
  delay?: number;
  x: number;
  y: number;
}

const IsometricBlock: React.FC<IsometricBlockProps> = ({
  label,
  sublabel,
  dark = false,
  delay = 0,
  x,
  y,
}) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: y + 18 }}
      animate={{
        opacity: 1,
        y: [y, y - 5, y],
      }}
      transition={{
        opacity: { duration: 0.5, delay },
        y: {
          duration: 4.8 + delay * 2,
          repeat: Infinity,
          ease: 'easeInOut',
          delay,
        },
      }}
      style={{ left: `${x}px`, top: `${y}px` }}
      className="absolute w-[84px] h-[84px] select-none"
    >
      {/* Clean isometric sculptural block */}
      <svg viewBox="0 0 100 100" className="w-full h-full">
        <defs>
          <linearGradient id={`top-${label}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={dark ? '#2B303B' : '#FFFFFF'} />
            <stop offset="100%" stopColor={dark ? '#181B22' : '#EDF0F4'} />
          </linearGradient>
          <linearGradient id={`left-${label}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={dark ? '#1E222B' : '#F3F5F8'} />
            <stop offset="100%" stopColor={dark ? '#101217' : '#DCE1E8'} />
          </linearGradient>
          <linearGradient id={`right-${label}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={dark ? '#13161C' : '#E5E9F0'} />
            <stop offset="100%" stopColor={dark ? '#0A0B0E' : '#CFD6E0'} />
          </linearGradient>
        </defs>
        {/* Top Face */}
        <polygon
          points="50,8 90,29 50,50 10,29"
          fill={`url(#top-${label})`}
          stroke={dark ? 'rgba(255,255,255,0.14)' : 'rgba(17,19,24,0.08)'}
          strokeWidth="1"
        />
        {/* Left Face */}
        <polygon
          points="10,29 50,50 50,92 10,71"
          fill={`url(#left-${label})`}
          stroke={dark ? 'rgba(255,255,255,0.08)' : 'rgba(17,19,24,0.08)'}
          strokeWidth="1"
        />
        {/* Right Face */}
        <polygon
          points="90,29 90,71 50,92 50,50"
          fill={`url(#right-${label})`}
          stroke={dark ? 'rgba(255,255,255,0.08)' : 'rgba(17,19,24,0.08)'}
          strokeWidth="1"
        />
        {/* Embossed emblem on Left Face */}
        <text
          x="30"
          y="64"
          textAnchor="middle"
          fill={dark ? '#F8FAFC' : '#111318'}
          fontSize="13"
          fontWeight="700"
          fontFamily="Plus Jakarta Sans, sans-serif"
          transform="skewY(26)"
        >
          {label}
        </text>
        {sublabel && (
          <text
            x="70"
            y="89"
            textAnchor="middle"
            fill={dark ? '#94A3B8' : '#64748B'}
            fontSize="9"
            fontWeight="600"
            fontFamily="JetBrains Mono, monospace"
            transform="skewY(-26)"
          >
            {sublabel}
          </text>
        )}
      </svg>
    </motion.div>
  );
};

export const KineticCubeCluster: React.FC<KineticCubeClusterProps> = ({ compact = false }) => {
  const [tilt, setTilt] = useState({ rx: 0, ry: 0 });

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width - 0.5;
    const ny = (e.clientY - rect.top) / rect.height - 0.5;
    setTilt({ rx: -ny * 10, ry: nx * 12 });
  };

  return (
    <div
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setTilt({ rx: 0, ry: 0 })}
      className={`relative flex items-center justify-center select-none ${
        compact ? 'h-44 w-56 sm:h-48 sm:w-64' : 'h-64 w-72 sm:h-72 sm:w-80'
      }`}
    >
      {/* Floor soft ambient shadow (zero blur filter cost) */}
      <div
        aria-hidden="true"
        className="absolute bottom-2 left-1/2 -translate-x-1/2 w-52 h-10 rounded-full"
        style={{
          background:
            'radial-gradient(closest-side, rgba(17,19,24,0.16) 0%, rgba(17,19,24,0.04) 60%, transparent 100%)',
        }}
      />

      <motion.div
        animate={{ rotateX: tilt.rx, rotateY: tilt.ry }}
        transition={{ type: 'spring', stiffness: 160, damping: 20 }}
        style={{ perspective: 900 }}
        className={`relative w-[240px] h-[220px] ${
          compact ? 'scale-[0.76] sm:scale-[0.86]' : 'scale-90 sm:scale-100'
        }`}
      >
        {/* Back / Upper Layer Cubes */}
        <IsometricBlock label="NSE" sublabel="F&O" dark x={76} y={8} delay={0.1} />
        <IsometricBlock label="CE" sublabel="CALL" x={118} y={32} delay={0.25} />
        <IsometricBlock label="PE" sublabel="PUT" dark x={34} y={32} delay={0.35} />

        {/* Front Layer Cubes */}
        <IsometricBlock label="₹" sublabel="NET" x={76} y={58} delay={0.45} />
        <IsometricBlock label="A1" sublabel="SYNC" dark x={118} y={84} delay={0.6} />
        <IsometricBlock label="PD" sublabel="LOCAL" x={34} y={84} delay={0.75} />

        {/* Signature Spinning 3D Gold Coin matching the reference video */}
        <div
          style={{ perspective: 700 }}
          className="absolute left-[10px] bottom-[12px] w-16 h-16 flex items-center justify-center"
        >
          <div className="animate-coin-spin relative w-14 h-14 rounded-full flex items-center justify-center shadow-[0_14px_24px_-6px_rgba(180,130,20,0.45)]">
            <div
              className="w-full h-full rounded-full border-2 border-[#FCE38A] flex items-center justify-center"
              style={{
                background:
                  'radial-gradient(circle at 30% 30%, #FFF3B0 0%, #E6B949 48%, #B4831D 100%)',
              }}
            >
              <div className="w-10 h-10 rounded-full border border-[#FFF3B0]/70 flex items-center justify-center text-[#5C3D04] font-display font-bold text-xl">
                ₹
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
};
