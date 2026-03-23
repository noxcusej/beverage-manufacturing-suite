import { useState, useEffect, useCallback } from 'react';
import { getInventory, saveInventory, addInventoryItem, deleteInventoryItem, getVendors } from '../data/store';

export default function Inventory() {
  const [inventory, setInventory] = useState(getInventory());
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const vendors = getVendors();

  const refresh = useCallback(() => setInventory(getInventory()), []);

  useEffect(() => {
    const handler = (e) => {
      if (e.detail.dataType === 'comanufacturing_inventory') refresh();
    };
    window.addEventListener('comanufacturing:datachange', handler);
    return () => window.removeEventListener('comanufacturing:datachange', handler);
  }, [refresh]);

  const filteredInventory = searchQuery
    ? inventory.filter(
        (item) =>
          item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (item.sku && item.sku.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : inventory;

  const selectedItem = inventory.find((i) => i.id === selectedItemId);
  const lowStockCount = inventory.filter((i) => i.currentStock < i.reorderPoint).length;
  const totalValue = inventory.reduce((sum, item) => {
    const price = item.priceTiers?.[0]?.price || 0;
    return sum + item.currentStock * price;
  }, 0);

  function selectItem(id) {
    setSelectedItemId(id);
  }

  function updateField(itemId, field, value) {
    const updated = inventory.map((item) =>
      item.id === itemId
        ? { ...item, [field]: value, lastUpdated: new Date().toLocaleString() }
        : item
    );
    setInventory(updated);
    saveInventory(updated);
  }

  function updatePriceTier(itemId, tierIndex, field, value) {
    const updated = inventory.map((item) => {
      if (item.id !== itemId) return item;
      const tiers = [...(item.priceTiers || [])];
      tiers[tierIndex] = { ...tiers[tierIndex], [field]: value };
      return { ...item, priceTiers: tiers, lastUpdated: new Date().toLocaleString() };
    });
    setInventory(updated);
    saveInventory(updated);
  }

  function addPriceTier(itemId) {
    const updated = inventory.map((item) => {
      if (item.id !== itemId) return item;
      const tiers = [...(item.priceTiers || [])];
      const lastTier = tiers[tiers.length - 1];
      const newMinQty = lastTier ? (lastTier.maxQty ? lastTier.maxQty + 1 : lastTier.minQty + 100) : 1;
      tiers.push({ minQty: newMinQty, maxQty: null, price: 0, buyUnit: item.unit, moq: newMinQty, setupFee: 0 });
      return { ...item, priceTiers: tiers };
    });
    setInventory(updated);
    saveInventory(updated);
  }

  function removePriceTier(itemId, tierIndex) {
    if (!confirm('Remove this price tier?')) return;
    const updated = inventory.map((item) => {
      if (item.id !== itemId) return item;
      const tiers = item.priceTiers.filter((_, i) => i !== tierIndex);
      return { ...item, priceTiers: tiers };
    });
    setInventory(updated);
    saveInventory(updated);
  }

  function handleDelete(itemId) {
    if (!confirm('Delete this inventory item? This cannot be undone.')) return;
    deleteInventoryItem(itemId);
    setSelectedItemId(null);
    refresh();
  }

  function handleAddNew() {
    const newId = addInventoryItem({
      sku: '',
      name: 'New Item',
      vendor: '',
      type: 'liquid',
      currentStock: 0,
      unit: 'gal',
      reorderPoint: 0,
      specificGravity: 1.0,
      priceTiers: [{ minQty: 1, maxQty: null, price: 0, buyUnit: 'gal', moq: 1, setupFee: 0 }],
      lastUpdated: new Date().toLocaleString(),
    });
    refresh();
    setSelectedItemId(newId);
  }

  return (
    <div className="main-container">
      {/* Left Panel: Items List */}
      <div className="items-panel">
        <div className="items-header">
          <input
            type="text"
            className="search-box"
            placeholder="Search inventory..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-label">Total Items</div>
              <div className="stat-value">{inventory.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Low Stock</div>
              <div className="stat-value" style={{ color: '#f59e0b' }}>{lowStockCount}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Value</div>
              <div className="stat-value" style={{ fontSize: 18 }}>
                ${totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </div>
            </div>
          </div>
        </div>

        <div className="items-list">
          {filteredInventory.map((item) => {
            const isLowStock = item.currentStock < item.reorderPoint;
            return (
              <div
                key={item.id}
                className={`item-card ${item.id === selectedItemId ? 'active' : ''}`}
                onClick={() => selectItem(item.id)}
              >
                <div className="item-name">{item.name}</div>
                <div className="item-meta">
                  <span>{item.sku || 'No SKU'}</span>
                  <span>{item.vendor || 'No vendor'}</span>
                </div>
                <div className="item-stock">
                  <span>{item.currentStock} {item.unit}</span>
                  <span className={`stock-badge ${isLowStock ? 'low-stock' : 'in-stock'}`}>
                    {isLowStock ? 'Low' : 'OK'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="items-panel-footer">
          <button className="btn btn-primary" onClick={handleAddNew} style={{ width: '100%', justifyContent: 'center' }}>
            + New Item
          </button>
        </div>
      </div>

      {/* Right Panel: Detail View */}
      <div className="detail-panel">
        {!selectedItem ? (
          <div className="detail-panel-empty">
            <div className="detail-panel-empty-icon">📦</div>
            <div>Select an item to view details</div>
            <div style={{ color: '#6b7280', fontSize: 13, marginTop: 12 }}>
              Use arrow keys to navigate &bull; Press Enter to edit &bull; Delete to remove
            </div>
          </div>
        ) : (
          <>
            <div className="erp-status">
              <div className="erp-status-dot disconnected" />
              <div>
                <strong>ERP Integration:</strong> Not connected
                <span style={{ color: '#6b7280', marginLeft: 8 }}>Manual entry mode</span>
              </div>
            </div>

            <div className="detail-header">
              <div className="detail-title">{selectedItem.name}</div>
              <div className="detail-subtitle">Last updated: {selectedItem.lastUpdated || 'Never'}</div>
            </div>

            <div className="detail-section">
              <div className="detail-label">SKU / Item Code</div>
              <div className="detail-value">
                <input
                  type="text"
                  defaultValue={selectedItem.sku || ''}
                  onBlur={(e) => updateField(selectedItem.id, 'sku', e.target.value)}
                  key={`sku-${selectedItem.id}`}
                />
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
              <div className="detail-label">Type</div>
              <div className="detail-value">
                <select
                  value={selectedItem.type}
                  onChange={(e) => updateField(selectedItem.id, 'type', e.target.value)}
                >
                  <option value="liquid">Liquid</option>
                  <option value="dry">Dry / Powder</option>
                </select>
              </div>
            </div>

            <div className="divider" />

            <div className="detail-section">
              <div className="detail-label">Current Stock</div>
              <div className="detail-value">
                <div className="input-group">
                  <input
                    type="number"
                    defaultValue={selectedItem.currentStock}
                    onBlur={(e) => updateField(selectedItem.id, 'currentStock', parseFloat(e.target.value) || 0)}
                    key={`stock-${selectedItem.id}`}
                  />
                  <select
                    value={selectedItem.unit}
                    onChange={(e) => updateField(selectedItem.id, 'unit', e.target.value)}
                  >
                    <option value="gal">gal</option>
                    <option value="L">L</option>
                    <option value="lbs">lbs</option>
                    <option value="kg">kg</option>
                    <option value="oz">oz</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="detail-section">
              <div className="detail-label">Reorder Point</div>
              <div className="detail-value">
                <div className="input-group">
                  <input
                    type="number"
                    defaultValue={selectedItem.reorderPoint}
                    onBlur={(e) => updateField(selectedItem.id, 'reorderPoint', parseFloat(e.target.value) || 0)}
                    key={`reorder-${selectedItem.id}`}
                  />
                  <span className="input-group-suffix">{selectedItem.unit}</span>
                </div>
              </div>
            </div>

            <div className="detail-section">
              <div className="detail-label">Status</div>
              <div className="detail-value" style={{ color: selectedItem.currentStock < selectedItem.reorderPoint ? '#f59e0b' : '#059669', fontSize: 14 }}>
                {selectedItem.currentStock < selectedItem.reorderPoint ? 'Below Reorder Point' : 'In Stock'}
              </div>
            </div>

            {selectedItem.type === 'liquid' && (
              <div className="detail-section">
                <div className="detail-label">Specific Gravity</div>
                <div className="detail-value">
                  <input
                    type="number"
                    step="0.01"
                    defaultValue={selectedItem.specificGravity || 1.0}
                    onBlur={(e) => updateField(selectedItem.id, 'specificGravity', parseFloat(e.target.value) || 1.0)}
                    key={`sg-${selectedItem.id}`}
                  />
                </div>
              </div>
            )}

            <div className="divider" />

            {/* Price Tiers */}
            <div className="detail-section">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div className="detail-label" style={{ marginBottom: 0 }}>Price Tiers</div>
                <button className="btn btn-small" onClick={() => addPriceTier(selectedItem.id)}>+ Add Tier</button>
              </div>
              <div className="price-tiers">
                <div className="price-tier price-tier-header">
                  <div>Quantity Range</div>
                  <div>Price</div>
                  <div>MOQ</div>
                  <div></div>
                </div>
                {selectedItem.priceTiers?.length > 0 ? (
                  selectedItem.priceTiers.map((tier, index) => (
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
                          step="0.0001"
                          defaultValue={tier.price}
                          onBlur={(e) => updatePriceTier(selectedItem.id, index, 'price', parseFloat(e.target.value) || 0)}
                          key={`price-${selectedItem.id}-${index}`}
                        />
                      </div>
                      <div>
                        <input
                          type="number"
                          className="tier-input"
                          defaultValue={tier.moq || tier.minQty}
                          onBlur={(e) => updatePriceTier(selectedItem.id, index, 'moq', parseInt(e.target.value) || 1)}
                          key={`moq-${selectedItem.id}-${index}`}
                        />
                      </div>
                      <div>
                        <button className="btn btn-icon btn-small" style={{ color: '#dc2626' }} onClick={() => removePriceTier(selectedItem.id, index)}>
                          x
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                    No price tiers defined
                  </div>
                )}
              </div>
            </div>

            <div className="divider" />

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-danger" onClick={() => handleDelete(selectedItem.id)} style={{ flex: 1 }}>
                Delete Item
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
