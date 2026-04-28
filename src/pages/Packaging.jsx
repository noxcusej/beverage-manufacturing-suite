import { useState, useCallback, useEffect } from 'react';
import { getPackaging, savePackaging, addPackagingItem as addPkgItem, deletePackagingItem, getVendors } from '../data/store';
import { getProducts, getQuantityTiers, lookupPrice, NEW_ART_PREP_FEE } from '../data/drayhorsePricing';

const categoryColors = {
  cans: { bg: '#dbeafe', color: '#1e40af' },
  labels: { bg: '#fce7f3', color: '#9d174d' },
  cases: { bg: '#d1fae5', color: '#065f46' },
  carriers: { bg: '#fef3c7', color: '#92400e' },
  pallets: { bg: '#e0e7ff', color: '#3730a3' },
};

function DrayhorsePricingGrid() {
  const products = getProducts();
  const tiers = getQuantityTiers();
  const [selectedProduct, setSelectedProduct] = useState(products[0].id);
  const [cartonQty, setCartonQty] = useState(25000);
  const [skuCount, setSkuCount] = useState(1);

  const product = products.find((p) => p.id === selectedProduct);
  const result = lookupPrice(selectedProduct, cartonQty, skuCount);

  const structureGroups = products.reduce((groups, p) => {
    if (!groups[p.structure]) groups[p.structure] = [];
    groups[p.structure].push(p);
    return groups;
  }, {});

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Drayhorse Carton Pricing</div>
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          4-Color Conventional Craft &bull; Prices per 1,000 cartons &bull; Delivered to Athens, PA
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
        <div className="form-group" style={{ margin: 0 }}>
          <label className="form-label">Carton Type</label>
          <select value={selectedProduct} onChange={(e) => setSelectedProduct(e.target.value)}>
            {Object.entries(structureGroups).map(([structure, prods]) => (
              <optgroup key={structure} label={`${structure} Can`}>
                {prods.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label className="form-label">Carton Quantity</label>
          <input
            type="number"
            value={cartonQty}
            onChange={(e) => setCartonQty(parseInt(e.target.value) || 0)}
            min={1000}
            step={1000}
          />
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label className="form-label"># of SKUs</label>
          <select value={skuCount} onChange={(e) => setSkuCount(parseInt(e.target.value))}>
            <option value={1}>1 SKU</option>
            <option value={2}>2 SKUs</option>
            <option value={3}>3 SKUs</option>
            <option value={4}>4 SKUs</option>
          </select>
        </div>
      </div>

      {/* Result Card */}
      {result && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20,
        }}>
          <div style={{ padding: 16, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: '#3b82f6', fontWeight: 600, marginBottom: 4 }}>Price / 1,000</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#1e40af' }}>${result.pricePerM.toFixed(2)}</div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>at {result.tierQty.toLocaleString()}+ tier</div>
          </div>
          <div style={{ padding: 16, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: '#16a34a', fontWeight: 600, marginBottom: 4 }}>Price / Carton</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#065f46' }}>${result.pricePerCarton.toFixed(4)}</div>
          </div>
          <div style={{ padding: 16, background: '#fefce8', border: '1px solid #fef08a', borderRadius: 8, textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: '#ca8a04', fontWeight: 600, marginBottom: 4 }}>Total Cost</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#92400e' }}>${result.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>{cartonQty.toLocaleString()} cartons</div>
          </div>
          <div style={{ padding: 16, background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 8, textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: '#7c3aed', fontWeight: 600, marginBottom: 4 }}>New Art Prep</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#5b21b6' }}>${NEW_ART_PREP_FEE}</div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>one-time fee</div>
          </div>
        </div>
      )}

      {/* Product Info */}
      {product && (
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <span>SKU: <strong>{product.sku}</strong></span>
          <span>Design: <strong>{product.design}</strong></span>
          {product.die && <span>Die: <strong>{product.die}</strong></span>}
          <span>Print: <strong>4/C + Aqueous</strong></span>
          <span>Board: <strong>17.9 Craft</strong></span>
        </div>
      )}

      {/* Full Grid Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Qty (cartons)</th>
              <th style={{ textAlign: 'right' }}>1 SKU</th>
              <th style={{ textAlign: 'right' }}>2 SKUs</th>
              <th style={{ textAlign: 'right' }}>3 SKUs</th>
              <th style={{ textAlign: 'right' }}>4 SKUs</th>
            </tr>
          </thead>
          <tbody>
            {product && tiers.map((tier, rowIdx) => {
              const isActiveTier = result && result.tierQty === tier;
              return (
                <tr key={tier} style={isActiveTier ? { background: '#eff6ff' } : undefined}>
                  <td style={{ fontWeight: 600 }}>{tier.toLocaleString()}</td>
                  {product.grid[rowIdx].map((price, colIdx) => {
                    const isActiveCell = isActiveTier && colIdx === skuCount - 1;
                    return (
                      <td
                        key={colIdx}
                        style={{
                          textAlign: 'right',
                          fontWeight: isActiveCell ? 700 : 400,
                          color: isActiveCell ? '#1e40af' : undefined,
                          background: isActiveCell ? '#dbeafe' : undefined,
                        }}
                      >
                        ${price.toFixed(2)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Packaging() {
  const [packaging, setPackaging] = useState(getPackaging());
  const [selectedId, setSelectedId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showPricingGrid, setShowPricingGrid] = useState(false);
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

  const selectedItem = showPricingGrid ? null : packaging.find((i) => i.id === selectedId);

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
    setShowPricingGrid(false);
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
          <button
            className="btn btn-small"
            onClick={() => { setShowPricingGrid(!showPricingGrid); setSelectedId(null); }}
            style={{
              width: '100%', justifyContent: 'center', marginTop: 8,
              background: showPricingGrid ? '#1e40af' : '#f3f4f6',
              color: showPricingGrid ? 'white' : '#374151',
              borderColor: showPricingGrid ? '#1e40af' : '#d1d5db',
            }}
          >
            {showPricingGrid ? 'Back to Items' : 'Drayhorse Pricing Grid'}
          </button>
        </div>

        <div className="items-list">
          {filtered.map((item) => {
            const catStyle = categoryColors[item.category] || { bg: '#f3f4f6', color: '#374151' };
            return (
              <div
                key={item.id}
                className={`item-card ${item.id === selectedId ? 'active' : ''}`}
                onClick={() => { setSelectedId(item.id); setShowPricingGrid(false); }}
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
        {showPricingGrid ? (
          <DrayhorsePricingGrid />
        ) : !selectedItem ? (
          <div className="detail-panel-empty">
            <div className="detail-panel-empty-icon">📦</div>
            <div>Select an item to view details</div>
            <button
              className="btn btn-small"
              onClick={() => setShowPricingGrid(true)}
              style={{ marginTop: 12 }}
            >
              View Drayhorse Pricing Grid
            </button>
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
                        placeholder={"\u221e"}
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
