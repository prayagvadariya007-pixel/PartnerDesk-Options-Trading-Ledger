import React, { useState } from 'react';
import { motion } from 'motion/react';
import { ArrowRight, Eye, EyeOff, Lock, ShieldCheck, UserCheck } from 'lucide-react';
import type { PartnerId } from '../../shared/types.ts';
import { api, type AuthStatusResponse } from '../lib/api.ts';
import { KineticCubeCluster } from './KineticCubeCluster.tsx';
import { SunlitGalleryBackdrop } from './SunlitGalleryBackdrop.tsx';

interface LoginViewProps {
  authStatus: AuthStatusResponse;
  onAuthenticated: (token: string, partnerId: PartnerId) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ authStatus, onAuthenticated }) => {
  const [partnerId, setPartnerId] = useState<PartnerId>('Prayag');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSetup = authStatus.needsInitialSetup;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (isSetup) {
      if (password.length < 6) {
        setError('Shared password must be at least 6 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
    } else if (!password) {
      setError('Please enter your shared partnership password.');
      return;
    }

    setLoading(true);
    try {
      const res = isSetup
        ? await api.setupPassword(partnerId, password)
        : await api.login(partnerId, password);
      onAuthenticated(res.token, res.partnerId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex flex-col justify-between overflow-x-hidden">
      <SunlitGalleryBackdrop />

      {/* Minimal Gallery Header */}
      <header className="w-full px-4 sm:px-8 lg:px-12 h-16 flex items-center justify-between border-b border-slate-900/8 backdrop-blur-md bg-white/55">
        <span className="font-display text-lg font-bold tracking-tight text-[#111318] whitespace-nowrap">
          PartnerDesk
        </span>
        <span className="text-xs font-medium text-slate-600 whitespace-nowrap">
          Prayag & Raj · Shared Ledger
        </span>
      </header>

      {/* Main Hero + Login Split (Desktop) / Compact Vertical Stack (Mobile) */}
      <main className="flex-1 w-full max-w-[1360px] mx-auto px-4 sm:px-8 lg:px-12 py-6 sm:py-10 flex items-center">
        <div className="w-full grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center">
          {/* Left Sunlit Architectural Hero (resembles reference video) */}
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
            className="lg:col-span-7 flex flex-col items-center lg:items-start text-center lg:text-left space-y-5"
          >
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600">
              <ShieldCheck className="w-4 h-4 text-[#111318]" />
              <span>Angel One Options Ledger · Shared Website Sync</span>
            </div>

            <h1
              className="font-display font-bold tracking-tight text-[#111318] leading-[1.06]"
              style={{
                fontSize: 'clamp(2rem, 4.2vw, 3.6rem)',
                textWrap: 'balance',
              }}
            >
              Rise Above The Noise.
              <br />
              Trade With Purpose.
            </h1>

            <p className="text-sm sm:text-base text-slate-600 max-w-xl leading-relaxed">
              Built for Prayag and Raj to track Angel One CE/PE options with automatic screenshot
              recognition, accurate NSE brokerage math, and real-time shared website sync across both accounts.
            </p>

            {/* 3D Kinetic Cubes & Spinning Gold Coin Showcase */}
            <div className="w-full flex justify-center lg:justify-start pt-1">
              <KineticCubeCluster />
            </div>
          </motion.div>

          {/* Right Ceramic Frosted Login Card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
            className="lg:col-span-5 w-full max-w-md mx-auto lg:ml-auto gallery-card rounded-3xl p-6 sm:p-8"
          >
            <div className="mb-6">
              <h2 className="font-display text-xl sm:text-2xl font-bold text-[#111318] tracking-tight">
                {isSetup ? 'Configure Access' : 'Partner Sign In'}
              </h2>
              <p className="text-xs sm:text-sm text-slate-600 mt-1.5 leading-relaxed">
                {isSetup
                  ? 'Set the shared access password once for both Prayag and Raj.'
                  : 'Sign in as Prayag or Raj with the shared password to view and edit the exact same shared ledger.'}
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  Partner ID
                </label>
                <div className="grid grid-cols-2 gap-2 p-1 bg-slate-900/5 border border-slate-900/10 rounded-full">
                  {(['Prayag', 'Raj'] as PartnerId[]).map((id) => {
                    const active = partnerId === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setPartnerId(id)}
                        className={`min-h-[42px] flex items-center justify-center gap-2 py-2 px-3 text-sm font-semibold rounded-full transition-all cursor-pointer whitespace-nowrap ${
                          active
                            ? 'bg-[#111318] text-white shadow-sm'
                            : 'text-slate-700 hover:text-[#111318]'
                        }`}
                      >
                        <UserCheck className="w-4 h-4" />
                        <span>{id}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label
                  htmlFor="partner-password"
                  className="block text-xs font-semibold text-slate-700 mb-1.5"
                >
                  {isSetup ? 'Create Shared Partnership Password' : 'Shared Partnership Password'}
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                    <Lock className="w-4 h-4" />
                  </div>
                  <input
                    id="partner-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter shared password"
                    autoComplete={isSetup ? 'new-password' : 'current-password'}
                    className="w-full h-12 pl-10 pr-11 text-sm bg-white/90 border border-slate-900/15 rounded-2xl text-[#111318] placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-[#111318]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-[#111318] cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {isSetup && (
                <div>
                  <label
                    htmlFor="confirm-password"
                    className="block text-xs font-semibold text-slate-700 mb-1.5"
                  >
                    Confirm Shared Password
                  </label>
                  <input
                    id="confirm-password"
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter password"
                    autoComplete="new-password"
                    className="w-full h-12 px-4 text-sm bg-white/90 border border-slate-900/15 rounded-2xl text-[#111318] placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-[#111318]"
                  />
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  className="p-3.5 text-xs sm:text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-2xl"
                >
                  {error}
                </div>
              )}

              <motion.button
                whileTap={{ scale: 0.98 }}
                type="submit"
                disabled={loading}
                className="w-full min-h-[48px] py-3 px-5 bg-[#111318] hover:bg-[#242934] disabled:bg-slate-400 text-white text-sm font-semibold rounded-full transition-colors flex items-center justify-center gap-2 cursor-pointer shadow-md"
              >
                <span>
                  {loading
                    ? isSetup
                      ? 'Configuring Access...'
                      : 'Signing In...'
                    : isSetup
                      ? 'Save Password & Enter Ledger'
                      : `Start Trading · ${partnerId}`}
                </span>
                <ArrowRight className="w-4 h-4" />
              </motion.button>
            </form>

            <div className="mt-6 pt-4 border-t border-slate-900/8 text-xs text-slate-500 flex items-center justify-between gap-2">
              <span>Shared Website Sync · Prayag & Raj</span>
              <span>Excel (.xlsx) ready</span>
            </div>
          </motion.div>
        </div>
      </main>
    </div>
  );
};
