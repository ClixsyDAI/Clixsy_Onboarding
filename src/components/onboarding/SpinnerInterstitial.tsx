'use client';

import { useEffect, useState } from 'react';

const CLIXSY_LOGO_URL = 'https://res.cloudinary.com/dovgh19xr/image/upload/v1766427227/new_logo_nvrux0.svg';

interface SpinnerInterstitialProps {
  message?: string;
  duration?: number;
  onComplete?: () => void;
}

export default function SpinnerInterstitial({
  message = 'Saving your progress...',
  duration = 1200,
  onComplete,
}: SpinnerInterstitialProps) {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(false);
      onComplete?.();
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, onComplete]);

  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 bg-[var(--side)] z-50 flex flex-col items-center justify-center">
      <div className="flex flex-col items-center gap-8">
        {/* Logo */}
        <div className="relative">
          <img
            src={CLIXSY_LOGO_URL}
            alt="Clixsy"
            className="h-12 object-contain"
          />
        </div>

        {/* Spinner ring */}
        <div className="relative w-16 h-16">
          <div className="absolute inset-0 border-4 border-[var(--border2)] rounded-full" />
          <div className="absolute inset-0 border-4 border-transparent border-t-[var(--green)] rounded-full animate-spin" />
        </div>

        {/* Message */}
        <p className="text-[var(--muted)] text-lg font-medium">
          {message}
        </p>

        {/* Progress dots */}
        <div className="flex gap-2">
          <span className="w-2 h-2 bg-[var(--green-fill)] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-2 h-2 bg-[var(--green-fill)] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-2 h-2 bg-[var(--green-fill)] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    </div>
  );
}
