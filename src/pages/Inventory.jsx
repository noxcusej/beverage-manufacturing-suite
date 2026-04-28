import { useState, useEffect, useCallback, useRef } from 'react';
import { getInventory, saveInventory, addInventoryItem, deleteInventoryItem } from '../data/store';

const UNIT_MAP = {
  'kg': 'kg', 'kilogram': 'kg', 'kilograms': 'kg',
  'g': 'g', 'gram': 'g', 'grams': 'g',
  'lb': 'lbs', 'lbs': 'lbs', 'pound': 'lbs', 'pounds': 'lbs',
  'oz': 'oz', 'ounce': 'oz', 'ounces': 'oz',
  'l': 'L', 'liter': 'L', 'litre': 'L', 'liters': 'L', 'litres': 'L',
  'ml': 'ml', 'milliliter': 'ml', 'millilitre': 'ml',
  'gal': 'gal', 'gallon': 'gal', 'gallons': 'gal',
  'unit': 'ea', 'units': 'ea', 'each': 'ea', 'ea': 'ea', 'pcs': 'ea',
};

function normalizeUnit(u) {
  if (!u) return 'gal';
  return UNIT_MAP[u.toLowerCase().trim()] || u.toLowerCase().trim();
}

export default function Inventory() {
  const [inventory, setInventory] = useState(getInventory());
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [importResult, setImportResult] = useState(null);
  const [pendingCSVData, setPendingCSVData] = useState(null); // holds parsed CSV data awaiting confirmation
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const fileInputRef = useRef(null);
  const refresh = useCallback(() => setInventory(getInventory()), []);

  useEffect(() => {
    const handler = (e) => {
      if (e.detail.dataType === 'inventory') refresh();
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

  // Parse CSV text into structured rows
  function parseCSVData(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return null;

    const headers = lines[0].split(',').map(h => h.replace(/^["']|["']$/g, '').trim().toLowerCase());

    const colMap = {};
    headers.forEach((h, i) => {
      if (['name', 'product name', 'material name', 'item name', 'item'].includes(h)) colMap.name = i;
      else if (['sku', 'internal code', 'code', 'item code', 'product code', 'variant code', 'variant code / sku'].includes(h)) colMap.sku = i;
      else if (['category', 'type', 'material type'].includes(h)) colMap.category = i;
      else if (['unit', 'uom', 'default uom', 'unit of measure', 'units of measure', 'stock uom'].includes(h)) colMap.unit = i;
      else if (['in stock', 'stock', 'quantity', 'qty', 'available', 'on hand', 'current stock', 'in_stock'].includes(h)) colMap.stock = i;
      else if (['reorder point', 'reorder', 'min stock', 'minimum stock', 'safety stock'].includes(h)) colMap.reorder = i;
      else if (['cost', 'price', 'unit cost', 'unit price', 'default supplier cost', 'supplier cost', 'average cost'].includes(h)) colMap.price = i;
      else if (['moq', 'minimum order', 'min order quantity', 'minimum order quantity'].includes(h)) colMap.moq = i;
      else if (['supplier', 'vendor', 'default supplier'].includes(h)) colMap.vendor = i;
      else if (['barcode', 'upc', 'ean'].includes(h)) colMap.barcode = i;
      else if (['notes', 'description'].includes(h)) colMap.notes = i;
    });

    if (colMap.name === undefined) colMap.name = 0;

    function parseCSVLine(line) {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' || ch === "'") {
          inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      result.push(current.trim());
      return result;
    }

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = parseCSVLine(lines[i]);
      const name = vals[colMap.name]?.replace(/^["']|["']$/g, '').trim();
      if (!name) continue;
      rows.push({
        name,
        sku: colMap.sku !== undefined ? vals[colMap.sku]?.replace(/^["']|["']$/g, '').trim() : '',
        unit: normalizeUnit(colMap.unit !== undefined ? vals[colMap.unit]?.replace(/^["']|["']$/g, '').trim() : 'gal'),
        stock: colMap.stock !== undefined ? parseFloat(vals[colMap.stock]) || 0 : 0,
        reorder: colMap.reorder !== undefined ? parseFloat(vals[colMap.reorder]) || 0 : 0,
        price: colMap.price !== undefined ? parseFloat(vals[colMap.price]) || 0 : 0,
        moq: colMap.moq !== undefined ? parseInt(vals[colMap.moq]) || 1 : 1,
        vendor: colMap.vendor !== undefined ? vals[colMap.vendor]?.replace(/^["']|["']$/g, '').trim() : '',
        category: colMap.category !== undefined ? vals[colMap.category]?.replace(/^["']|["']$/g, '').trim() : 'ingredient',
      });
    }
    return rows;
  }

  // Execute the actual import (called directly or after confirmation)
  function executeImport(rows, overwriteKatana) {
    const existingInventory = getInventory();

    // If overwriting, remove all previous Katana imports first
    let baseInventory = existingInventory;
    if (overwriteKatana) {
      baseInventory = existingInventory.filter(item => !item.katanaImport);
    }

    const existingByName = {};
    const existingBySku = {};
    baseInventory.forEach(item => {
      existingByName[item.name.toLowerCase()] = item;
      if (item.sku) existingBySku[item.sku.toLowerCase()] = item;
    });

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let replaced = overwriteKatana ? existingInventory.length - baseInventory.length : 0;

    for (const row of rows) {
      const existing = (row.sku && existingBySku[row.sku.toLowerCase()]) || existingByName[row.name.toLowerCase()];

      if (existing) {
        const idx = baseInventory.findIndex(it => it.id === existing.id);
        if (idx !== -1) {
          baseInventory[idx] = {
            ...baseInventory[idx],
            currentStock: row.stock || baseInventory[idx].currentStock,
            reorderPoint: row.reorder || baseInventory[idx].reorderPoint,
            unit: row.unit || baseInventory[idx].unit,
            sku: row.sku || baseInventory[idx].sku,
            vendor: row.vendor || baseInventory[idx].vendor,
            lastUpdated: new Date().toLocaleString(),
            katanaImport: true,
          };
          if (row.price > 0) {
            if (baseInventory[idx].priceTiers?.length > 0) {
              baseInventory[idx].priceTiers[0].price = row.price;
            } else {
              baseInventory[idx].priceTiers = [{ minQty: 1, maxQty: null, price: row.price, buyUnit: row.unit, moq: row.moq, setupFee: 0 }];
            }
          }
          updated++;
        }
      } else {
        const isLiquid = ['gal', 'L', 'ml', 'oz'].includes(row.unit);
        baseInventory.push({
          id: 'INV-' + String(baseInventory.length + 1).padStart(3, '0'),
          name: row.name,
          sku: row.sku || '',
          vendor: row.vendor || '',
          type: isLiquid ? 'liquid' : 'dry',
          category: row.category,
          currentStock: row.stock,
          unit: row.unit,
          reorderPoint: row.reorder,
          specificGravity: 1.0,
          priceTiers: row.price > 0 ? [{
            minQty: 1, maxQty: null, price: row.price, buyUnit: row.unit, moq: row.moq, setupFee: 0,
          }] : [],
          lastUpdated: new Date().toLocaleString(),
          katanaImport: true,
        });
        created++;
      }
    }

    saveInventory(baseInventory);
    setInventory(baseInventory);
    const msg = overwriteKatana && replaced > 0
      ? `Replaced ${replaced} previous Katana items. ${created} new, ${updated} updated${skipped ? `, ${skipped} skipped` : ''}`
      : `Imported ${rows.length} rows: ${created} new, ${updated} updated`;
    setImportResult({ created, updated, skipped, replaced, total: rows.length, message: msg });
    setTimeout(() => setImportResult(null), 5000);
  }

  function handleImportCSV(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const text = evt.target.result;
        const rows = parseCSVData(text);
        if (!rows || rows.length === 0) {
          setImportResult({ error: 'CSV has no data rows' });
          setTimeout(() => setImportResult(null), 5000);
          return;
        }

        // Check if there are existing Katana imports
        const existingKatanaCount = getInventory().filter(item => item.katanaImport).length;

        if (existingKatanaCount > 0) {
          // Show confirmation modal
          setPendingCSVData(rows);
          setShowImportConfirm(true);
        } else {
          // No previous Katana imports, just import directly
          executeImport(rows, false);
        }
      } catch (err) {
        setImportResult({ error: 'Failed to parse CSV: ' + err.message });
        setTimeout(() => setImportResult(null), 5000);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function handleImportConfirm(overwrite) {
    setShowImportConfirm(false);
    if (pendingCSVData) {
      executeImport(pendingCSVData, overwrite);
      setPendingCSVData(null);
    }
  }

  return (
    <div className="main-container">
      {/* Hidden file input for CSV import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.tsv,.txt"
        style={{ display: 'none' }}
        onChange={handleImportCSV}
      />

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

          {importResult && (
            <div style={{
              padding: '8px 12px',
              borderRadius: 8,
              fontSize: 12,
              marginBottom: 8,
              background: importResult.error ? '#fef2f2' : '#f0fdf4',
              color: importResult.error ? '#dc2626' : '#059669',
              border: `1px solid ${importResult.error ? '#fecaca' : '#bbf7d0'}`,
            }}>
              {importResult.error
                ? importResult.error
                : importResult.message || `Imported ${importResult.total} rows: ${importResult.created} new, ${importResult.updated} updated${importResult.skipped ? `, ${importResult.skipped} skipped` : ''}`
              }
            </div>
          )}

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
                <div className="item-name" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {item.name}
                  {item.katanaImport && (
                    <span style={{ fontSize: 9, fontWeight: 700, background: '#eef2ff', color: '#4f46e5', padding: '1px 5px', borderRadius: 4, letterSpacing: 0.5, whiteSpace: 'nowrap' }}>KATANA</span>
                  )}
                </div>
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

        <div className="items-panel-footer" style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={handleAddNew} style={{ flex: 1, justifyContent: 'center' }}>
            + New Item
          </button>
          <button
            className="btn"
            onClick={() => fileInputRef.current?.click()}
            style={{ flex: 1, justifyContent: 'center', background: '#f3f4f6', border: '1px solid #d1d5db' }}
            title="Import from Katana CSV export"
          >
            Import CSV
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
              <div className={`erp-status-dot ${selectedItem.katanaImport ? 'connected' : 'disconnected'}`} />
              <div>
                <strong>{selectedItem.katanaImport ? 'Katana' : 'ERP Integration'}:</strong>{' '}
                {selectedItem.katanaImport ? 'Imported from CSV' : 'Not connected'}
                <span style={{ color: '#6b7280', marginLeft: 8 }}>
                  {selectedItem.katanaImport ? `Last sync: ${selectedItem.lastUpdated}` : 'Manual entry mode'}
                </span>
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

      {/* Katana Import Overwrite Confirmation Modal */}
      {showImportConfirm && (() => {
        const existingKatanaCount = inventory.filter(item => item.katanaImport).length;
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
            onClick={() => { setShowImportConfirm(false); setPendingCSVData(null); }}>
            <div style={{ background: 'white', borderRadius: 16, padding: 28, maxWidth: 440, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
              onClick={(e) => e.stopPropagation()}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <span style={{ fontSize: 9, fontWeight: 700, background: '#eef2ff', color: '#4f46e5', padding: '2px 6px', borderRadius: 4, letterSpacing: 0.5 }}>KATANA</span>
                <span style={{ fontSize: 16, fontWeight: 700, color: '#1f2937' }}>Previous Import Detected</span>
              </div>
              <p style={{ fontSize: 14, color: '#4b5563', lineHeight: 1.6, margin: '0 0 8px' }}>
                You have <strong>{existingKatanaCount} items</strong> from a previous Katana import.
              </p>
              <p style={{ fontSize: 14, color: '#4b5563', lineHeight: 1.6, margin: '0 0 20px' }}>
                Would you like to <strong>overwrite</strong> the previous import (replace all Katana items) or <strong>merge</strong> (update existing, add new)?
              </p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  className="btn"
                  onClick={() => handleImportConfirm(true)}
                  style={{ flex: 1, background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', fontWeight: 600, padding: '10px 16px', borderRadius: 10, cursor: 'pointer' }}
                >
                  Overwrite ({existingKatanaCount} items)
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => handleImportConfirm(false)}
                  style={{ flex: 1, fontWeight: 600, padding: '10px 16px', borderRadius: 10, cursor: 'pointer' }}
                >
                  Merge
                </button>
              </div>
              <button
                onClick={() => { setShowImportConfirm(false); setPendingCSVData(null); }}
                style={{ width: '100%', marginTop: 10, background: 'none', border: 'none', color: '#9ca3af', fontSize: 13, cursor: 'pointer', padding: 8 }}
              >
                Cancel
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
