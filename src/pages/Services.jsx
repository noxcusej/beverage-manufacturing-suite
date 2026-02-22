import { useState, useCallback, useEffect } from 'react';
import { getServices, saveServices, addService as addSvc, deleteService, getVendors } from '../data/store';

const feeTypeColors = {
  'per-unit': { bg: '#dbeafe', color: '#1e40af' },
  fixed: { bg: '#fce7f3', color: '#9d174d' },
  'per-batch': { bg: '#d1fae5', color: '#065f46' },
  'per-pallet': { bg: '#fef3c7', color: '#92400e' },
};

export default function Services() {
  const [services, setServices] = useState(getServices());
  const [selectedId, setSelectedId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const vendors = getVendors();

  const refresh = useCallback(() => setServices(getServices()), []);

  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener('comanufacturing:datachange', handler);
    return () => window.removeEventListener('comanufacturing:datachange', handler);
  }, [refresh]);

  const filtered = searchQuery
    ? services.filter((s) => s.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : services;

  const selectedItem = services.find((s) => s.id === selectedId);

  function updateField(id, field, value) {
    const updated = services.map((s) => (s.id === id ? { ...s, [field]: value } : s));
    setServices(updated);
    saveServices(updated);
  }

  function handleDelete(id) {
    if (!confirm('Delete this service?')) return;
    deleteService(id);
    setSelectedId(null);
    refresh();
  }

  function handleAddNew() {
    const newId = addSvc({
      name: 'New Service',
      providerId: '',
      feeType: 'per-unit',
      rate: 0,
      minimumCharge: 0,
      leadTimeDays: 0,
      notes: '',
    });
    refresh();
    setSelectedId(newId);
  }

  return (
    <div className="main-container">
      <div className="items-panel">
        <div className="items-header">
          <input
            type="text"
            className="search-box"
            placeholder="Search services..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-label">Total Services</div>
              <div className="stat-value">{services.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Fee Types</div>
              <div className="stat-value">{new Set(services.map((s) => s.feeType)).size}</div>
            </div>
          </div>
        </div>

        <div className="items-list">
          {filtered.map((item) => {
            const feeStyle = feeTypeColors[item.feeType] || { bg: '#f3f4f6', color: '#374151' };
            return (
              <div
                key={item.id}
                className={`item-card ${item.id === selectedId ? 'active' : ''}`}
                onClick={() => setSelectedId(item.id)}
              >
                <div className="item-name">{item.name}</div>
                <div className="item-meta">
                  <span className="badge" style={{ background: feeStyle.bg, color: feeStyle.color }}>
                    {item.feeType}
                  </span>
                  <span>{vendors.find((v) => v.id === item.providerId)?.name || 'No provider'}</span>
                </div>
                <div className="item-stock">
                  <span>Lead: {item.leadTimeDays}d</span>
                  <span>${item.rate?.toFixed(2) || '0.00'}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="items-panel-footer">
          <button className="btn btn-primary" onClick={handleAddNew} style={{ width: '100%', justifyContent: 'center' }}>
            + New Service
          </button>
        </div>
      </div>

      <div className="detail-panel">
        {!selectedItem ? (
          <div className="detail-panel-empty">
            <div className="detail-panel-empty-icon">⚙️</div>
            <div>Select a service to view details</div>
          </div>
        ) : (
          <>
            <div className="detail-header">
              <div className="detail-title">{selectedItem.name}</div>
              <div className="detail-subtitle">{selectedItem.feeType}</div>
            </div>

            <div className="detail-section">
              <div className="detail-label">Service Name</div>
              <div className="detail-value">
                <input
                  type="text"
                  defaultValue={selectedItem.name}
                  onBlur={(e) => updateField(selectedItem.id, 'name', e.target.value)}
                  key={`name-${selectedItem.id}`}
                />
              </div>
            </div>

            <div className="detail-section">
              <div className="detail-label">Fee Type</div>
              <div className="detail-value">
                <select
                  value={selectedItem.feeType}
                  onChange={(e) => updateField(selectedItem.id, 'feeType', e.target.value)}
                >
                  <option value="per-unit">Per Unit</option>
                  <option value="fixed">Fixed</option>
                  <option value="per-batch">Per Batch</option>
                  <option value="per-pallet">Per Pallet</option>
                </select>
              </div>
            </div>

            <div className="detail-section">
              <div className="detail-label">Rate ($)</div>
              <div className="detail-value">
                <input
                  type="number"
                  step="0.01"
                  defaultValue={selectedItem.rate}
                  onBlur={(e) => updateField(selectedItem.id, 'rate', parseFloat(e.target.value) || 0)}
                  key={`rate-${selectedItem.id}`}
                />
              </div>
            </div>

            <div className="detail-section">
              <div className="detail-label">Minimum Charge ($)</div>
              <div className="detail-value">
                <input
                  type="number"
                  step="0.01"
                  defaultValue={selectedItem.minimumCharge}
                  onBlur={(e) => updateField(selectedItem.id, 'minimumCharge', parseFloat(e.target.value) || 0)}
                  key={`min-${selectedItem.id}`}
                />
              </div>
            </div>

            <div className="detail-section">
              <div className="detail-label">Lead Time (days)</div>
              <div className="detail-value">
                <input
                  type="number"
                  defaultValue={selectedItem.leadTimeDays}
                  onBlur={(e) => updateField(selectedItem.id, 'leadTimeDays', parseInt(e.target.value) || 0)}
                  key={`lead-${selectedItem.id}`}
                />
              </div>
            </div>

            <div className="detail-section">
              <div className="detail-label">Notes</div>
              <div className="detail-value">
                <input
                  type="text"
                  defaultValue={selectedItem.notes || ''}
                  onBlur={(e) => updateField(selectedItem.id, 'notes', e.target.value)}
                  key={`notes-${selectedItem.id}`}
                />
              </div>
            </div>

            <div className="divider" />

            <button className="btn btn-danger" onClick={() => handleDelete(selectedItem.id)} style={{ width: '100%' }}>
              Delete Service
            </button>
          </>
        )}
      </div>
    </div>
  );
}
