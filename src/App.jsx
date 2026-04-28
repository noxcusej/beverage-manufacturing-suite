import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { lazy, Suspense, useEffect, useState } from 'react';
import { initStore, hydrateAll } from './data/store';
import Layout from './components/Layout';

const BatchCalculator = lazy(() => import('./pages/BatchCalculator'));
const CoPackingCalculator = lazy(() => import('./pages/CoPackingCalculator'));
const Packaging = lazy(() => import('./pages/Packaging'));
const Inventory = lazy(() => import('./pages/Inventory'));
const FormulaLibrary = lazy(() => import('./pages/FormulaLibrary'));
const Summary = lazy(() => import('./pages/Summary'));
const ClientProfile = lazy(() => import('./pages/ClientProfile'));
const Services = lazy(() => import('./pages/Services'));

function AppStatus({ error }) {
  return (
    <div className="app-status">
      <div>
        <div className="app-status-title">{error ? 'Using local defaults' : 'Loading...'}</div>
        <div className="app-status-detail">
          {error ? 'Cloud sync was unavailable, so the app loaded with local seed data.' : 'Syncing beverage manufacturing data'}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [hydrateError, setHydrateError] = useState(null);

  useEffect(() => {
    initStore();
    hydrateAll()
      .catch((err) => {
        console.error('[App] Data hydration failed:', err);
        setHydrateError(err);
      })
      .finally(() => setReady(true));
  }, []);

  if (!ready) {
    return <AppStatus error={hydrateError} />;
  }

  return (
    <BrowserRouter>
      <Suspense fallback={<AppStatus />}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<BatchCalculator />} />
            <Route path="/batch-calculator" element={<BatchCalculator />} />
            <Route path="/copacking" element={<CoPackingCalculator />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/packaging" element={<Packaging />} />
            <Route path="/formulas" element={<FormulaLibrary />} />
            <Route path="/summary" element={<Summary />} />
            <Route path="/clients" element={<ClientProfile />} />
            <Route path="/clients/:clientName" element={<ClientProfile />} />
            <Route path="/services" element={<Services />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
