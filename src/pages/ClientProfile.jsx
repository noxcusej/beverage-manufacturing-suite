import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getClients, saveClient, deleteClient, getFormulas, getRuns, saveFormula, saveRun } from '../data/store';

export default function ClientProfile() {
  const { clientName } = useParams();
  const navigate = useNavigate();
  const [clients, setClients] = useState(getClients());
  const [allFormulas, setAllFormulas] = useState([]);
  const [allRuns, setAllRuns] = useState([]);

  useEffect(() => {
    const refresh = () => {
      setClients(getClients());
      setAllFormulas(getFormulas());
      setAllRuns(getRuns());
    };
    refresh();
    window.addEventListener('comanufacturing:datachange', refresh);
    return () => window.removeEventListener('comanufacturing:datachange', refresh);
  }, []);

  const clientList = useMemo(() => {
    const nameSet = new Set();
    const byName = {};
    clients.forEach((c) => { nameSet.add(c.name); byName[c.name] = c; });
    allFormulas.forEach((f) => { if (f.client) nameSet.add(f.client); });
    allRuns.forEach((r) => { if (r.client) nameSet.add(r.client); });
    nameSet.delete(''); nameSet.delete('Uncategorized');
    return [...nameSet].sort().map((name) => ({
      name, ...(byName[name] || {}),
      formulaCount: allFormulas.filter((f) => f.client === name).length,
      runCount: allRuns.filter((r) => r.client === name).length,
    }));
  }, [clients, allFormulas, allRuns]);

  // ── Detail View ──
  if (clientName) {
    const decoded = decodeURIComponent(clientName);
    const client = clients.find((c) => c.name === decoded) || { name: decoded };
    const formulas = allFormulas.filter((f) => f.client === decoded);
    const runs = allRuns.filter((r) => r.client === decoded);
    const contacts = client.contacts || [];

    function save(updates) {
      saveClient({ ...client, id: client.id, name: decoded, ...updates });
      setClients(getClients());
    }

    function handleLogoUpload(e) {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => save({ logo: reader.result });
      reader.readAsDataURL(file);
    }

    function handleDeleteClient() {
      if (!confirm(`Delete client "${decoded}" and remove client tag from all formulas and runs? This cannot be undone.`)) return;
      if (client.id) deleteClient(client.id);
      // Clear client field from formulas and runs
      allFormulas.filter((f) => f.client === decoded).forEach((f) => saveFormula({ ...f, client: '' }));
      allRuns.filter((r) => r.client === decoded).forEach((r) => saveRun({ ...r, client: '' }));
      navigate('/clients');
    }

    function handleAddFormula() {
      const name = prompt('Formula name:');
      if (!name?.trim()) return;
      saveFormula({ name: name.trim(), client: decoded, ingredients: [], batchSize: 100, batchSizeUnit: 'gal' });
    }

    function handleAddRun() {
      const name = prompt('Run name:');
      if (!name?.trim()) return;
      saveRun({ name: name.trim(), client: decoded, flavors: [], config: {} });
    }

    function handleAddContact() {
      const name = prompt('Contact name:');
      if (!name?.trim()) return;
      save({ contacts: [...contacts, { id: crypto.randomUUID(), name: name.trim(), email: '', phone: '', role: '' }] });
    }

    function updateContact(idx, field, value) {
      const updated = contacts.map((c, i) => i === idx ? { ...c, [field]: value } : c);
      save({ contacts: updated });
    }

    function removeContact(idx) {
      save({ contacts: contacts.filter((_, i) => i !== idx) });
    }

    return (
      <div className="container">
        {/* Header */}
        <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', marginBottom: 24 }}>
          <label style={{ cursor: 'pointer', flexShrink: 0 }}>
            <input type="file" accept="image/*" onChange={handleLogoUpload} style={{ display: 'none' }} />
            {client.logo ? (
              <img src={client.logo} alt={decoded} style={{ width: 80, height: 80, borderRadius: 'var(--radius)', objectFit: 'cover', border: '2px solid var(--border)' }} />
            ) : (
              <div style={{ width: 80, height: 80, borderRadius: 'var(--radius)', background: 'var(--brand-100)', border: '2px dashed var(--brand-200)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 800, color: 'var(--brand)' }}>
                {decoded.charAt(0).toUpperCase()}
              </div>
            )}
            <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', marginTop: 4 }}>Upload logo</div>
          </label>
          <div style={{ flex: 1 }}>
            <Link to="/clients" style={{ fontSize: 12, color: 'var(--brand)', fontWeight: 600, marginBottom: 4, display: 'block' }}>&larr; All Clients</Link>
            <h1 style={{ fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>{decoded}</h1>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 4 }}>
              {formulas.length} formula{formulas.length !== 1 ? 's' : ''} &bull; {runs.length} run{runs.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {client.pipedriveUrl && (
              <a href={client.pipedriveUrl} target="_blank" rel="noopener noreferrer" className="btn" style={{ fontSize: 12 }}>Pipedrive</a>
            )}
            <button className="btn btn-danger" onClick={handleDeleteClient} style={{ fontSize: 12 }}>Delete Client</button>
          </div>
        </div>

        {/* Notes + Pipedrive */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          <textarea defaultValue={client.notes || ''} placeholder="Client notes..."
            onBlur={(e) => save({ notes: e.target.value })}
            style={{ flex: 1, height: 50, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }} />
          <input type="text" defaultValue={client.pipedriveUrl || ''} placeholder="Pipedrive URL..."
            onBlur={(e) => save({ pipedriveUrl: e.target.value })}
            style={{ width: 280, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, fontFamily: 'inherit' }} />
        </div>

        {/* Contacts */}
        <div className="section" style={{ marginBottom: 20 }}>
          <div className="section-header">
            <div className="section-title">Contacts ({contacts.length})</div>
            <button className="btn btn-small btn-primary" onClick={handleAddContact}>+ Add Contact</button>
          </div>
          <div>
            {contacts.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No contacts added</div>
            ) : (
              <table>
                <thead>
                  <tr><th>Name</th><th>Role</th><th>Email</th><th>Phone</th><th style={{ width: 32 }}></th></tr>
                </thead>
                <tbody>
                  {contacts.map((ct, idx) => (
                    <tr key={ct.id}>
                      <td><input type="text" defaultValue={ct.name} style={{ width: '100%', minWidth: 120 }} onBlur={(e) => updateContact(idx, 'name', e.target.value)} /></td>
                      <td><input type="text" defaultValue={ct.role} placeholder="Role..." style={{ width: '100%' }} onBlur={(e) => updateContact(idx, 'role', e.target.value)} /></td>
                      <td><input type="email" defaultValue={ct.email} placeholder="email@..." style={{ width: '100%' }} onBlur={(e) => updateContact(idx, 'email', e.target.value)} /></td>
                      <td><input type="tel" defaultValue={ct.phone} placeholder="Phone..." style={{ width: 120 }} onBlur={(e) => updateContact(idx, 'phone', e.target.value)} /></td>
                      <td><button className="btn btn-small btn-danger" onClick={() => removeContact(idx)}>x</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Formulas */}
        <div className="section" style={{ marginBottom: 20 }}>
          <div className="section-header">
            <div className="section-title">Formulas ({formulas.length})</div>
            <button className="btn btn-small btn-primary" onClick={handleAddFormula}>+ New Formula</button>
          </div>
          <div>
            {formulas.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No formulas yet</div>
            ) : (
              <table>
                <thead><tr><th>Name</th><th>Batch Size</th><th>Ingredients</th><th>Updated</th></tr></thead>
                <tbody>
                  {formulas.map((f) => (
                    <tr key={f.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/batch-calculator?formula=${f.id}`)}>
                      <td style={{ fontWeight: 600, color: 'var(--brand)' }}>{f.name}</td>
                      <td>{f.batchSize || '\u2014'} {f.batchSizeUnit || ''}</td>
                      <td>{f.ingredients?.length || 0}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{f.updatedAt ? new Date(f.updatedAt).toLocaleDateString() : '\u2014'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Runs */}
        <div className="section">
          <div className="section-header">
            <div className="section-title">Runs ({runs.length})</div>
            <button className="btn btn-small btn-primary" onClick={handleAddRun}>+ New Run</button>
          </div>
          <div>
            {runs.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No runs yet</div>
            ) : (
              <table>
                <thead><tr><th>Run Name</th><th>SKUs</th><th style={{ textAlign: 'right' }}>Total Cases</th><th>Updated</th></tr></thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/copacking?run=${r.id}`)}>
                      <td style={{ fontWeight: 600, color: 'var(--brand)' }}>{r.name}</td>
                      <td>{r.flavors?.length || 0}</td>
                      <td style={{ textAlign: 'right' }}>{(r.flavors || []).reduce((s, f) => s + (f.cases || 0), 0).toLocaleString()}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : '\u2014'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── List View ──
  function handleAddClient() {
    const name = prompt('Client name:');
    if (!name?.trim()) return;
    saveClient({ name: name.trim(), contacts: [] });
    setClients(getClients());
    navigate(`/clients/${encodeURIComponent(name.trim())}`);
  }

  return (
    <div className="container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Clients</h1>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 4 }}>{clientList.length} client{clientList.length !== 1 ? 's' : ''}</p>
        </div>
        <button className="btn btn-primary" onClick={handleAddClient}>+ New Client</button>
      </div>

      {clientList.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>
          <p>No clients yet. Create a client or assign one to a formula or run.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {clientList.map((c) => (
            <Link key={c.name} to={`/clients/${encodeURIComponent(c.name)}`}
              style={{ background: 'var(--surface)', border: '1px solid var(--border-light)', borderRadius: 'var(--radius)', padding: 20, boxShadow: '0 1px 2px rgba(0,0,0,0.04)', transition: 'box-shadow 0.15s, transform 0.15s', textDecoration: 'none', color: 'inherit', display: 'block' }}
              onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.04)'; e.currentTarget.style.transform = 'none'; }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
                {c.logo ? (
                  <img src={c.logo} alt={c.name} style={{ width: 44, height: 44, borderRadius: 6, objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: 44, height: 44, borderRadius: 6, background: 'var(--brand-100)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 800, color: 'var(--brand)' }}>
                    {c.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <div style={{ fontSize: 15, fontWeight: 700 }}>{c.name}</div>
              </div>
              <div style={{ display: 'flex', gap: 16, fontSize: 13, color: 'var(--text-secondary)' }}>
                <span><strong style={{ color: 'var(--text-primary)' }}>{c.formulaCount}</strong> formulas</span>
                <span><strong style={{ color: 'var(--text-primary)' }}>{c.runCount}</strong> runs</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
