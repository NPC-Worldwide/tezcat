import React from 'react';

interface EarthViewProps {
  className?: string;
}

const EarthView: React.FC<EarthViewProps> = ({ className = '' }) => {
  return (
    <div className={`flex items-center justify-center w-full h-full bg-gray-900 ${className}`}>
      <div className="text-center">
        <div className="text-6xl mb-4">🌍</div>
        <p className="text-gray-400 text-sm">3D Globe view coming soon</p>
      </div>
    </div>
  );
};

export default EarthView;
