import { NavLink, Outlet } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { getCurrentBatch, clearBatch } from '../data/store';
import CommandPalette from './CommandPalette';

export default function Layout() {
  const [batch, setBatch] = useState(getCurrentBatch());

  useEffect(() => {
    const handler = () => setBatch(getCurrentBatch());
    window.addEventListener('comanufacturing:datachange', handler);
    return () => window.removeEventListener('comanufacturing:datachange', handler);
  }, []);

  const handleClearBatch = () => {
    clearBatch();
    setBatch(null);
  };

  return (
    <>
      <CommandPalette />

      <header className="app-header">
        <div className="app-branding">
          <div className="app-logo">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M4 10L8 6L12 10L16 6" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 14L8 10L12 14L16 10" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <div className="app-title">Co-Manufacturing Suite</div>
            <div className="app-subtitle">Batch & Packaging Calculator</div>
          </div>
        </div>

        <nav className="app-nav">
          <NavLink to="/batch-calculator" className={({ isActive }) => isActive ? 'active' : ''}>Batch Calculator</NavLink>
          <NavLink to="/copacking" className={({ isActive }) => isActive ? 'active' : ''}>Co-Packing</NavLink>
          <NavLink to="/inventory" className={({ isActive }) => isActive ? 'active' : ''}>Inventory</NavLink>
          <NavLink to="/services" className={({ isActive }) => isActive ? 'active' : ''}>Services</NavLink>
          <NavLink to="/packaging" className={({ isActive }) => isActive ? 'active' : ''}>Packaging</NavLink>
          <NavLink to="/mission-control" className="mission-control-link">Mission Control</NavLink>
        </nav>
      </header>

      {batch && (
        <div className="batch-info-banner">
          <div className="batch-info-inner">
            <div className="batch-info-details">
              <span className="batch-info-label">Current Batch:</span>
              <strong>{batch.formulaName || '\u2014'}</strong>
              <span className="batch-info-sep">|</span>
              <span>{batch.batchSize || '\u2014'} {batch.batchSizeUnit || 'gal'}</span>
              <span className="batch-info-sep">|</span>
              <span>{batch.totalUnits || '\u2014'} units</span>
              <span className="batch-info-sep">|</span>
              <span className="batch-info-time">
                {batch.timestamp ? new Date(batch.timestamp).toLocaleString() : '\u2014'}
              </span>
            </div>
            <button className="batch-info-clear" onClick={handleClearBatch}>
              Clear Batch
            </button>
          </div>
        </div>
      )}

      <div className="app-content">
        <Outlet />
      </div>
    </>
  );
}
