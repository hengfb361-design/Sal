import React from 'react';
import { Logo } from './Logo';

/**
 * The app has one screen, so the header carries the brand only — no tabs, no
 * account menu.
 */
export const Header: React.FC = () => {
  return (
    <header className="sticky top-0 z-40 bg-[#0b0f17]/95 backdrop-blur-md border-b border-slate-800/80">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-2.5 sm:py-3">
        <div className="flex items-center justify-between gap-3">
          {/* Brand */}
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 select-none">
            {/* Same dark tone as the page, so the indigo mark sits on its own tile. */}
            <span className="flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-[#0b0f17] border border-slate-800 shadow-lg shadow-black/30 shrink-0">
              <Logo className="w-6 h-6 sm:w-7 sm:h-7" />
            </span>

            <span className="min-w-0">
              <span className="flex items-center gap-2">
                <h1 className="text-base sm:text-xl font-bold tracking-tight text-white leading-tight whitespace-nowrap">
                  <span className="text-emerald-400 font-extrabold">AI</span>{' '}
                  <span>translate video</span>
                </h1>
              </span>
              <span className="hidden sm:block text-[11px] md:text-xs text-slate-400 font-light truncate">
                វេទិកាបកប្រែ និងបញ្ចូលសំឡេងខ្មែរ AI
              </span>
            </span>
          </div>
        </div>
      </div>
    </header>
  );
};
