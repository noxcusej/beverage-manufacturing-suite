import { useState, useCallback, useEffect } from 'react';
import { getPackaging, savePackaging, addPackagingItem as addPkgItem, deletePackagingItem, getVendors } from '../data/store';

const categoryColors = {
  cans: { bg: '#dbeafe', color: '#1e40af' },
  labels: { bg: '#fce7f3', color: '#9d174d' },
  cases: { bg: '#d1fae5', color: '#065f46' },
  carriers: { bg: '#fef3c7', color: '#92400e' },
  pallets: { bg: '#e0e7ff', color: '#3730a3' },
};

export default function Packaging() {
  const [packaging, setPackaging] = useState(getPackaging());
  const [selectedId, setSelectedId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const vendors = getVendors();

  const refresh = useCallback(() => setPackaging(getPackaging()), []);

  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener('comanufacturing:datachange', handler);
    return () => window.removeEventListener('comanufacturing:datachange', handler);
  }, [refresh]);

  const filtered = searchQuery
    ? packaging.filter((item) => item.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : packaging;

  const selectedItem = packaging.find((i) => i.id === selectedId);

  function updateField(id, field, value) {
    const updated = packaging.map((item) =>
      item.id === id ? { ...item, [field]: value } : item
    );
    setPackaging(updated);
    savePackaging(updated);
  }

  function updatePriceTier(id, tierIndex, field, value) {
    const updated = packaging.map((item) => {
      if (item.id !== id) return item;
      const tiers = [...(item.priceTiers || [])];
      tiers[tierIndex] = { ...tiers[tierIndex], [field]: value };
      return { ...item, priceTiers: tiers };
    });
    setPackaging(updated);
    savePackaging(updated);
  }

  function addPriceTier(id) {
    const updated = packaging.map((item) => {
      if (item.id !== id) return item;
      const tiers = [...(item.priceTiers || [])];
      const last = tiers[tiers.length - 1];
      const newMin = last ? (last.maxQty ? last.maxQty + 1 : last.minQty + 1000) : 1;
      tiers.push({ minQty: newMin, maxQty: null, price: 0, setupFee: 0 });
      return { ...item, priceTiers: tiers };
    });
    setPackaging(updated);
    savePackaging(updated);
  }

  function removePriceTier(id, tierIndex) {
    if (!confirm('Remove this price tier?')) return;
    const updated = packaging.map((item) => {
      if (item.id !== id) return item;
      return { ...item, priceTiers: item.priceTiers.filter((_, i) => i !== tierIndex) };
    });
    setPackaging(updated);
    savePackaging(updated);
  }

  function handleDelete(id) {
    if (!confirm('Delete this packaging item?')) return;
    deletePackagingItem(id);
    setSelectedId(null);
    refresh();
  }

  function handleAddNew() {
    const newId = addPkgItem({
      name: 'New Packaging Item',
      vendorId: '',
      category: 'cans',
      unit: 'ea',
      priceTiers: [{ minQty: 1, maxQty: null, price: 0, setupFee: 0 }],
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
            placeholder="Search packaging..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-label">Total Items</div>
              <div className="stat-value">{packaging.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Categories</div>
              <div className="stat-value">{new Set(packaging.map((p) => p.category)).size}</div>
            </div>
          </div>
        </div>

        <div className="items-list">
          {filtered.map((item) => {
            const catStyle = categoryColors[item.category] || { bg: '#f3f4f6', color: '#374151' };
            return (
              <div
                key={item.id}
                className={`item-card ${item.id === selectedId ? 'active' : ''}`}
                onClick={() => setSelectedId(item.id)}
              >
                <div className="item-name">{item.name}</div>
                <div className="item-meta">
                  <span
                    className="badge"
                    style={{ background: catStyle.bg, color: catStyle.color }}
                  >
                    {item.category}
                  </span>
                  <span>{vendors.find((v) => v.id === item.vendorId)?.name || 'No vendor'}</span>
                </div>
                <div className="item-stock">
                  <span>Lead: {item.leadTimeDays}d</span>
                  <span>${item.priceTiers?.[0]?.price?.toFixed(2) || '0.00'}/ea</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="items-panel-footer">
          <button className="btn btn-primary" onClick={handleAddNew} style={{ width: '100%', justifyContent: 'center' }}>
            + New Packaging Item
          </button>
        </div>
      </div>

      <div className="detail-panel">
        {!selectedItem ? (
          <div className="detail-panel-empty">
            <div className="detail-panel-empty-icon">📦</div>
            <div>Select an item to view details</div>
          </div>
        ) : (
          <>
            <div className="detail-header">
              <div className="detail-title">{selectedItem.name}</div>
              <div className="detail-subtitle">
                {selectedItem.category} &bull; {selectedItem.unit}
              </div>
            </div>

            <div className="detail-section">
              <div className="detail-label">Item Name</div>
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
              <div className="detail-label">Category</div>
              <div className="detail-value">
                <select
                  value={selectedItem.category}
                  onChange={(e) => updateField(selectedItem.id, 'category', e.target.value)}
                >
                  <option value="cans">Cans</option>
                  <option value="labels">Labels</option>
                  <option value="cases">Cases</option>
                  <option value="carriers">Carriers</option>
                  <option value="pallets">Pallets</option>
                </select>
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

            <div className="detail-section">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div className="detail-label" style={{ marginBottom: 0 }}>Price Tiers</div>
                <button className="btn btn-small" onClick={() => addPriceTier(selectedItem.id)}>+ Add Tier</button>
              </div>
              <div className="price-tiers">
                <div className="price-tier price-tier-header">
                  <div>Qty Range</div>
                  <div>Price</div>
                  <div>Setup Fee</div>
                  <div></div>
                </div>
                {selectedItem.priceTiers?.map((tier, index) => (
                  <div key={index} className="price-tier">
                    <div style={{ fontSize: 13 }}>
                      <input
                        type="number"
                        className="tier-input"
                        defaultValue={tier.minQty}
                        style={{ width: 60, display: 'inline-block', marginRight: 4 }}
                        onBlur={(e) => updatePriceTier(selectedItem.id, index, 'minQty', parseInt(e.target.value) || 0)}
                        key={`min-${selectedItem.id}-${index}`}
                      />
                      -
                      <input
                        type="number"
                        className="tier-input"
                        defaultValue={tier.maxQty || ''}
                        placeholder="\u221e"
                        style={{ width: 60, display: 'inline-block', marginLeft: 4 }}
                        onBlur={(e) => updatePriceTier(selectedItem.id, index, 'maxQty', e.target.value ? parseInt(e.target.value) : null)}
                        key={`max-${selectedItem.id}-${index}`}
                      />
                    </div>
                    <div>
                      <input
                        type="number"
                        className="tier-input"
                        step="0.01"
                        defaultValue={tier.price}
                        onBlur={(e) => updatePriceTier(selectedItem.id, index, 'price', parseFloat(e.target.value) || 0)}
                        key={`price-${selectedItem.id}-${index}`}
                      />
                    </div>
                    <div>
                      <input
                        type="number"
                        className="tier-input"
                        step="1"
                        defaultValue={tier.setupFee || 0}
                        onBlur={(e) => updatePriceTier(selectedItem.id, index, 'setupFee', parseFloat(e.target.value) || 0)}
                        key={`setup-${selectedItem.id}-${index}`}
                      />
                    </div>
                    <div>
                      <button className="btn btn-icon btn-small" style={{ color: '#dc2626' }} onClick={() => removePriceTier(selectedItem.id, index)}>
                        x
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="divider" />

            <button className="btn btn-danger" onClick={() => handleDelete(selectedItem.id)} style={{ width: '100%' }}>
              Delete Packaging Item
            </button>
          </>
        )}
      </div>
    </div>
  );
}
