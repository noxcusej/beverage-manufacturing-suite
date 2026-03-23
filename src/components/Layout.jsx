import { NavLink, Outlet } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { getCurrentBatch, clearBatch } from '../data/store';
import CommandPalette from './CommandPalette';

export default function Layout() {
  const [batch, setBatch] = useState(getCurrentBatch());
  const [collapsed, setCollapsed] = useState(false);

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

      <div className="app-shell">
        {/* Sidebar */}
        <aside className={`app-sidebar${collapsed ? ' app-sidebar--collapsed' : ''}`}>
          <div className="sidebar-brand">
            <div className="sidebar-logo">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                <path d="M5 11L9 7L13 11L17 7" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M5 15L9 11L13 15L17 11" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            {!collapsed && (
              <div>
                <div className="sidebar-title">BeverageOS</div>
                <div className="sidebar-subtitle">Precision Manufacturing</div>
              </div>
            )}
          </div>

          <nav className="sidebar-nav">
            <NavLink to="/batch-calculator" className={({ isActive }) => isActive ? 'active' : ''} title="Formula Calculator">
              <span className="nav-icon">&#x2211;</span>
              {!collapsed && 'Formula Calculator'}
            </NavLink>
            <NavLink to="/copacking" className={({ isActive }) => isActive ? 'active' : ''} title="Run Quoting">
              <span className="nav-icon">&#x2B1C;</span>
              {!collapsed && 'Run Quoting'}
            </NavLink>
            <NavLink to="/clients" className={({ isActive }) => isActive ? 'active' : ''} title="Clients">
              <span className="nav-icon">&#x263A;</span>
              {!collapsed && 'Clients'}
            </NavLink>
            <NavLink to="/inventory" className={({ isActive }) => isActive ? 'active' : ''} title="Inventory">
              <span className="nav-icon">&#x1F4E6;</span>
              {!collapsed && 'Inventory'}
            </NavLink>
            <NavLink to="/packaging" className={({ isActive }) => isActive ? 'active' : ''} title="Packaging">
              <span className="nav-icon">&#x2750;</span>
              {!collapsed && 'Packaging'}
            </NavLink>
            <NavLink to="/formulas" className={({ isActive }) => isActive ? 'active' : ''} title="Formulas">
              <span className="nav-icon">&#x2697;</span>
              {!collapsed && 'Formulas'}
            </NavLink>
            <NavLink to="/summary" className={({ isActive }) => isActive ? 'active' : ''} title="Summary">
              <span className="nav-icon">&#x2211;</span>
              {!collapsed && 'Summary'}
            </NavLink>
            <NavLink to="/services" className={({ isActive }) => isActive ? 'active' : ''} title="Services">
              <span className="nav-icon">&#x2692;</span>
              {!collapsed && 'Services'}
            </NavLink>
            <NavLink to="/mission-control" className={({ isActive }) => isActive ? 'active' : ''} title="Mission Control">
              <span className="nav-icon">&#x1F4E1;</span>
              {!collapsed && 'Mission Control'}
            </NavLink>
            <NavLink to="/consolidated-po" className={({ isActive }) => isActive ? 'active' : ''} title="Consolidated PO">
              <span className="nav-icon">&#x1F4CB;</span>
              {!collapsed && 'Consolidated PO'}
            </NavLink>
          </nav>

          <div className="sidebar-footer">
            {!collapsed && (
              <>
                <a href="#settings"><span>&#x2699;</span> Settings</a>
                <a href="#support"><span>&#x2709;</span> Support</a>
              </>
            )}
            <button
              className="sidebar-collapse-btn"
              onClick={() => setCollapsed(c => !c)}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? '›' : '‹'}
            </button>
          </div>
        </aside>

        {/* Main */}
        <div className="app-main">
          <header className="app-topbar">
            <input
              type="text"
              className="topbar-search"
              placeholder="Search projects or logs..."
            />
            <div className="topbar-actions">
              <a href="#reports" className="topbar-link">Reports</a>
              <a href="#history" className="topbar-link">History</a>
            </div>
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
        </div>
      </div>
    </>
  );
}
