import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { useAuth } from './lib/auth';
import { AdminCandidates } from './pages/AdminCandidates';
import { AdminJudges } from './pages/AdminJudges';
import { AdminPanels } from './pages/AdminPanels';
import { AdminReports } from './pages/AdminReports';
import { AdminResults } from './pages/AdminResults';
import { AdminRounds } from './pages/AdminRounds';
import { AdminVerticals } from './pages/AdminVerticals';
import { Candidates } from './pages/Candidates';
import { Dashboard } from './pages/Dashboard';
import { Evaluate } from './pages/Evaluate';
import { Login } from './pages/Login';
import { MyEvaluations } from './pages/MyEvaluations';
import { OfflinePrep } from './pages/OfflinePrep';
import { PanelVerify } from './pages/PanelVerify';
import { Register } from './pages/Register';
import { Settings } from './pages/Settings';
import { SyncStatus } from './pages/SyncStatus';

export default function App() {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <div className="empty" style={{ paddingTop: '4rem' }}>
        <span className="spinner" /> Loading…
      </div>
    );
  }
  if (status === 'signed_out') {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/register" element={<Navigate to="/" replace />} />
        <Route path="/verify" element={<PanelVerify />} />
        <Route path="/candidates" element={<Candidates />} />
        <Route path="/candidates/:id/evaluate" element={<Evaluate />} />
        <Route path="/my-evaluations" element={<MyEvaluations />} />
        <Route path="/offline" element={<OfflinePrep />} />
        <Route path="/sync" element={<SyncStatus />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/admin" element={<Dashboard />} />
        <Route path="/admin/candidates" element={<AdminCandidates />} />
        <Route path="/admin/panels" element={<AdminPanels />} />
        <Route path="/admin/judges" element={<AdminJudges />} />
        <Route path="/admin/verticals" element={<AdminVerticals />} />
        <Route path="/admin/rounds" element={<AdminRounds />} />
        <Route path="/admin/results" element={<AdminResults />} />
        <Route path="/admin/reports" element={<AdminReports />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
