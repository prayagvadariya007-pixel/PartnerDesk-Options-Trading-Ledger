import React from 'react';

export const SunlitGalleryBackdrop: React.FC = () => {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 overflow-hidden -z-10 select-none"
      style={{
        background:
          'radial-gradient(120% 90% at 68% 12%, #ffffff 0%, #f1f3f6 42%, #dfe4ea 100%)',
      }}
    >
      {/* Pre-blended warm daylight beam sweep (zero runtime blur filter cost) */}
      <div
        className="absolute -top-24 -right-20 w-[75vw] h-[70vh] rounded-full opacity-80"
        style={{
          background:
            'radial-gradient(closest-side, rgba(255,252,242,0.92) 0%, rgba(255,248,225,0.38) 52%, rgba(212,175,55,0.06) 76%, transparent 100%)',
        }}
      />

      {/* Pre-blended soft architectural window shadow */}
      <div
        className="absolute -bottom-24 -left-16 w-[65vw] h-[60vh] rounded-full opacity-55"
        style={{
          background:
            'radial-gradient(closest-side, rgba(148,163,184,0.22) 0%, rgba(203,213,225,0.08) 58%, transparent 100%)',
        }}
      />

      {/* Soft diagonal sunlit botanical shadows using radial gradients (no feGaussianBlur) */}
      <svg
        viewBox="0 0 1440 900"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 w-full h-full opacity-[0.06]"
      >
        <defs>
          <radialGradient id="leafShadowGrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#111318" stopOpacity="0.95" />
            <stop offset="55%" stopColor="#111318" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#111318" stopOpacity="0" />
          </radialGradient>
        </defs>
        <g fill="url(#leafShadowGrad)">
          <ellipse cx="320" cy="680" rx="250" ry="52" transform="rotate(-28 320 680)" />
          <ellipse cx="470" cy="740" rx="210" ry="44" transform="rotate(-22 470 740)" />
          <ellipse cx="1090" cy="210" rx="280" ry="58" transform="rotate(-34 1090 210)" />
          <ellipse cx="1220" cy="310" rx="230" ry="46" transform="rotate(-26 1220 310)" />
          <ellipse cx="940" cy="540" rx="320" ry="50" transform="rotate(-30 940 540)" />
        </g>
      </svg>
    </div>
  );
};
