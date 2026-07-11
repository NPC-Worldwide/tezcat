import React, { useState, useEffect } from 'react';
import { Minus, Square, X, Maximize2 } from 'lucide-react';
import UpdateChecker from './UpdateChecker';

/**
 * Custom draggable title bar for tezcat. The window uses
 * titleBarStyle: 'hiddenInset', so on macOS the native traffic lights remain
 * (top-left) and this bar provides the rest of the chrome + hosts the update
 * checker. On Windows/Linux it also renders min/max/close controls.
 */
const TitleBar: React.FC = () => {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(navigator.platform.startsWith('Mac'));
    window.api?.windowState?.isMaximized?.().then(setIsMaximized);
    const unsubscribe = window.api?.onWindowStateChange?.((state) => {
      setIsMaximized(state.isMaximized);
    });
    return () => { unsubscribe?.(); };
  }, []);

  const handleMinimize = () => window.api?.windowControls?.minimize?.();
  const handleMaximize = () => window.api?.windowControls?.maximize?.();
  const handleClose = () => window.api?.windowControls?.close?.();

  // On macOS the traffic lights live top-left; reserve space and show no
  // custom window buttons.
  if (isMac) {
    return (
      <div
        className="h-8 flex-shrink-0 flex items-center justify-between select-none pl-20 theme-bg-secondary border-b theme-border"
        style={{ WebkitAppRegion: 'drag' }}
      >
        <span className="text-xs font-medium theme-text-muted">Tezcat</span>
        <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' }}>
          <UpdateChecker />
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-9 flex-shrink-0 flex items-center justify-between theme-bg-secondary border-b theme-border select-none"
      style={{ WebkitAppRegion: 'drag' }}
    >
      <div className="flex items-center gap-2 px-3" style={{ WebkitAppRegion: 'no-drag' }}>
        <div className="w-4 h-4 rounded-sm bg-emerald-500 flex items-center justify-center">
          <span className="text-[8px] font-bold text-white">Z</span>
        </div>
        <span className="text-xs font-medium theme-text-primary">Tezcat</span>
      </div>

      <div className="flex-1 flex items-center justify-center">
        <span className="text-xs theme-text-muted">Tezcat</span>
      </div>

      <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' }}>
        <UpdateChecker />
        <button
          onClick={handleMinimize}
          className="w-12 h-9 flex items-center justify-center theme-text-muted hover:theme-bg-tertiary hover:theme-text-primary transition-colors"
          title="Minimize"
        >
          <Minus size={14} />
        </button>
        <button
          onClick={handleMaximize}
          className="w-12 h-9 flex items-center justify-center theme-text-muted hover:theme-bg-tertiary hover:theme-text-primary transition-colors"
          title={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <Square size={12} /> : <Maximize2 size={12} />}
        </button>
        <button
          onClick={handleClose}
          className="w-12 h-9 flex items-center justify-center theme-text-muted hover:bg-red-600 hover:text-white transition-colors"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};

export default TitleBar;