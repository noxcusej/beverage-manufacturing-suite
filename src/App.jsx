import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { initStore, hydrateAll } from './data/store';
import Layout from './components/Layout';
import CoPackingCalculator from './pages/CoPackingCalculator';
import Packaging from './pages/Packaging';
import Inventory from './pages/Inventory';
import BatchCalculator from './pages/BatchCalculator';
import FormulaLibrary from './pages/FormulaLibrary';
import Summary from './pages/Summary';
import ClientProfile from './pages/ClientProfile';
import Services from './pages/Services';
import ConsolidatedPO from './pages/ConsolidatedPO';

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    initStore();
    hydrateAll().finally(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'system-ui' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>Loading...</div>
          <div style={{ fontSize: 14, color: '#888' }}>Syncing data from cloud</div>
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
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
<Route path="/consolidated-po" element={<ConsolidatedPO />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
