import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import AutoDelivery from './pages/AutoDelivery';
import Calculator from './pages/Calculator';
import Journal from './pages/Journal';
import Rules from './pages/Rules';
import Scanner from './pages/Scanner';
import Inventory from './pages/Inventory';
import Quality from './pages/Quality';
import Settings from './pages/Settings';
import Start from './pages/Start';
import Tools from './pages/Tools';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/calculator" replace />} />
        <Route path="/calculator" element={<Calculator />} />
        <Route path="/scanner" element={<Scanner />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/quality" element={<Quality />} />
        <Route path="/journal" element={<Journal />} />
        <Route path="/auto-delivery" element={<AutoDelivery />} />
        <Route path="/rules" element={<Rules />} />
        <Route path="/tools" element={<Tools />} />
        <Route path="/start" element={<Start />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/calculator" replace />} />
      </Route>
    </Routes>
  );
}
