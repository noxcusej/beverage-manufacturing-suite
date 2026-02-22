import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useEffect } from 'react';
import { initStore } from './data/store';
import Layout from './components/Layout';
import Home from './pages/Home';
import BatchCalculator from './pages/BatchCalculator';
import CoPackingCalculator from './pages/CoPackingCalculator';
import Inventory from './pages/Inventory';
import Packaging from './pages/Packaging';
import Services from './pages/Services';
import MissionControl from './pages/MissionControl';

export default function App() {
  useEffect(() => {
    initStore();
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/batch-calculator" element={<BatchCalculator />} />
          <Route path="/copacking" element={<CoPackingCalculator />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/packaging" element={<Packaging />} />
          <Route path="/services" element={<Services />} />
          <Route path="/mission-control" element={<MissionControl />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
