import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useEffect } from 'react';
import { initStore } from './data/store';
import Layout from './components/Layout';
import Home from './pages/Home';
import CoPackingCalculator from './pages/CoPackingCalculator';
import Packaging from './pages/Packaging';
import BatchCalculator from './pages/BatchCalculator';
import FormulaLibrary from './pages/FormulaLibrary';
import Summary from './pages/Summary';
import ClientProfile from './pages/ClientProfile';

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
          <Route path="/packaging" element={<Packaging />} />
          <Route path="/formulas" element={<FormulaLibrary />} />
          <Route path="/summary" element={<Summary />} />
          <Route path="/clients" element={<ClientProfile />} />
          <Route path="/clients/:clientName" element={<ClientProfile />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
