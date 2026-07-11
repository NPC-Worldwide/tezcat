import React, { useState, useCallback } from 'react';
import Tezcat from './components/Tezcat';
import TitleBar from './components/TitleBar';
import { AiFeatureProvider } from './components/AiFeatureContext';
import { getHomeDir } from './lib/utils';

export default function App() {
  const [currentPath, setCurrentPath] = useState<string>('');
  React.useEffect(() => { getHomeDir().then((dir) => setCurrentPath(dir)); }, []);
  const handleClose = useCallback(() => {}, []);
  if (!currentPath) {
    return (
      <div className="h-screen w-screen theme-bg-primary flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }
  return (
    <div className="h-screen w-screen theme-bg-primary overflow-hidden flex flex-col">
      <TitleBar />
      <div className="flex-1 flex overflow-hidden">
        <AiFeatureProvider>
          <Tezcat />
        </AiFeatureProvider>
      </div>
    </div>
  );
}
