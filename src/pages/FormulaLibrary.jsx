import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getFormulas, getInventory, saveAllFormulas, saveFormula, deleteFormula, hydrateFormulasFromSupabase, getClients, saveBatch } from '../data/store';

function generateFormulaId() {
  return 'FRM-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
}

export default function FormulaLibrary() {
  const navigate = useNavigate();
  const [formulas, setFormulas] = useState(getFormulas());
  const [expandedFolders, setExpandedFolders] = useState({});
  const [draggedIdx, setDraggedIdx] = useState(null);
  const [dragOverClient, setDragOverClient] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFormula, setSelectedFormula] = useState(null);
  const [versionModal, setVersionModal] = useState(null); // { formulaIndex, versions }
  const fileInputRef = useRef(null);

  const refresh = useCallback(() => {
    const latest = getFormulas();
    setFormulas(latest);
    // Keep selectedFormula in sync with updated data
    setSelectedFormula(prev => {
      if (!prev) return null;
      const updated = latest[prev._index];
      if (updated && updated.id === prev.id) return { ...updated, _index: prev._index };
      // If index shifted, find by ID
      const idx = latest.findIndex(f => f.id === prev.id);
      if (idx !== -1) return { ...latest[idx], _index: idx };
      return null;
    });
  }, []);

  useEffect(() => {
    // Hydrate formulas from Supabase on mount
    hydrateFormulasFromSupabase().then(() => refresh());

    const handler = () => refresh();
    window.addEventListener('comanufacturing:datachange', handler);
    return () => window.removeEventListener('comanufacturing:datachange', handler);
  }, [refresh]);

  // Group by client (include empty folders from clients store)
  const groups = {};
  getClients().forEach((c) => { if (c.name && !groups[c.name]) groups[c.name] = []; });
  formulas.forEach((f, idx) => {
    const client = f.client || 'Uncategorized';
    if (!groups[client]) groups[client] = [];
    groups[client].push({ ...f, _index: idx });
  });

  const sortedClients = Object.keys(groups).sort((a, b) => {
    if (a === 'Uncategorized') return 1;
    if (b === 'Uncategorized') return -1;
    return a.localeCompare(b);
  });

  const filtered = searchQuery
    ? sortedClients.filter(client =>
        client.toLowerCase().includes(searchQuery.toLowerCase()) ||
        groups[client].some(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : sortedClients;

  function toggleFolder(client) {
    setExpandedFolders(prev => ({ ...prev, [client]: !prev[client] }));
  }

  function expandAll() {
    const all = {};
    sortedClients.forEach(c => { all[c] = true; });
    setExpandedFolders(all);
  }

  function collapseAll() {
    setExpandedFolders({});
  }

  function moveFormula(formulaIndex, targetClient) {
    const updated = [...formulas];
    updated[formulaIndex] = {
      ...updated[formulaIndex],
      client: targetClient,
      updatedAt: new Date().toISOString(),
    };
    saveAllFormulas(updated);
    setFormulas(updated);
  }

  function removeFormula(index) {
    const formula = formulas[index];
    if (!confirm(`Delete "${formula.name}"?`)) return;
    deleteFormula(formula.id); // store.js: removes from localStorage + Supabase
    const updated = getFormulas();
    setFormulas(updated);
    if (selectedFormula?._index === index) setSelectedFormula(null);
  }

  function renameClient(oldName) {
    const newName = prompt(`Rename folder "${oldName}" to:`, oldName);
    if (!newName || !newName.trim() || newName.trim() === oldName) return;
    const updated = formulas.map(f =>
      (f.client || 'Uncategorized') === oldName
        ? { ...f, client: newName.trim(), updatedAt: new Date().toISOString() }
        : f
    );
    saveAllFormulas(updated);
    setFormulas(updated);
  }

  function addFolder() {
    const name = prompt('New client folder name:');
    if (!name || !name.trim()) return;
    // Pre-expand it so they see it
    setExpandedFolders(prev => ({ ...prev, [name.trim()]: true }));
    // Create a placeholder entry so the folder shows
    const updated = [...formulas, {
      id: generateFormulaId(),
      version: '1.0',
      name: '(New Formula)',
      client: name.trim(),
      baseYield: 100,
      baseYieldUnit: 'gal',
      batchSize: 100,
      batchSizeUnit: 'gal',
      ingredients: [],
      versions: [],
      createdAt: new Date().toISOString(),
    }];
    saveAllFormulas(updated);
    setFormulas(updated);
  }

  function addFormulaToClient(client) {
    const name = prompt('New formula name:', '');
    if (!name || !name.trim()) return;
    const updated = [...formulas, {
      id: generateFormulaId(),
      version: '1.0',
      name: name.trim(),
      client: client,
      baseYield: 100,
      baseYieldUnit: 'gal',
      batchSize: 100,
      batchSizeUnit: 'gal',
      ingredients: [],
      versions: [],
      createdAt: new Date().toISOString(),
    }];
    saveAllFormulas(updated);
    setFormulas(updated);
    setExpandedFolders(prev => ({ ...prev, [client]: true }));
  }

  function renameFormula(index) {
    const formula = formulas[index];
    const newName = prompt('Rename formula:', formula.name);
    if (!newName || !newName.trim() || newName.trim() === formula.name) return;
    const updated = [...formulas];
    updated[index] = { ...updated[index], name: newName.trim(), updatedAt: new Date().toISOString() };
    saveAllFormulas(updated);
    setFormulas(updated);
    if (selectedFormula?._index === index) {
      setSelectedFormula({ ...updated[index], _index: index });
    }
  }

  function duplicateFormula(index) {
    const original = formulas[index];
    const newFormula = {
      ...original,
      id: generateFormulaId(),
      name: original.name + ' (Copy)',
      versions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    delete newFormula._index;
    const updated = [...formulas, newFormula];
    saveAllFormulas(updated);
    setFormulas(updated);
    const client = newFormula.client || 'Uncategorized';
    setExpandedFolders(prev => ({ ...prev, [client]: true }));
  }

  function restoreVersion(formulaIndex, versionIndex) {
    const formula = formulas[formulaIndex];
    const versions = formula.versions || [];
    const version = versions[versionIndex];
    if (!version) return;
    if (!confirm(`Restore "${formula.name}" to ${version.versionLabel}? Current state will be saved as a new version.`)) return;

    const now = new Date().toISOString();
    // Save current state as a version
    const currentSnapshot = { ...formula };
    delete currentSnapshot.versions;
    delete currentSnapshot._index;
    currentSnapshot.versionDate = now;
    currentSnapshot.versionLabel = 'v' + (versions.length + 1);
    const updatedVersions = [...versions, currentSnapshot];

    // Restore old version data but keep id, versions array, and createdAt
    const restored = {
      ...version,
      id: formula.id,
      versions: updatedVersions,
      createdAt: formula.createdAt,
      updatedAt: now,
    };
    delete restored.versionDate;
    delete restored.versionLabel;

    const updated = [...formulas];
    updated[formulaIndex] = restored;
    saveAllFormulas(updated);
    setFormulas(updated);
    setSelectedFormula({ ...restored, _index: formulaIndex });
  }

  function exportFormula(formula) {
    const inventory = getInventory();
    const exportData = {
      ...formula,
      ingredients: (formula.ingredients || []).map(ing => {
        const inv = inventory.find(i => i.id === ing.inventoryId);
        return { ...ing, name: inv?.name || ing.draftName || 'Unknown', sku: inv?.sku || '' };
      }),
      exportedAt: new Date().toISOString(),
    };
    delete exportData._index;
    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${formula.name.replace(/[^a-zA-Z0-9]/g, '_')}_formula.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importFormula(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data.name || !data.ingredients) {
          alert('Invalid formula file.');
          return;
        }
        const updated = [...formulas, { ...data, createdAt: new Date().toISOString() }];
        saveAllFormulas(updated);
        setFormulas(updated);
        const client = data.client || 'Uncategorized';
        setExpandedFolders(prev => ({ ...prev, [client]: true }));
        alert(`Imported "${data.name}" into ${client}`);
      } catch (err) {
        alert('Error reading file: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function loadInBatchCalc(formula) {
    // Save as current working formula and navigate
    const batch = {
      formulaId: formula.id,
      formulaName: formula.name,
      formulaClient: formula.client || 'Uncategorized',
      batchSize: formula.batchSize,
      batchSizeUnit: formula.batchSizeUnit,
      baseYield: formula.baseYield,
      ingredients: formula.ingredients,
      timestamp: new Date().toISOString(),
    };
    saveBatch(batch);
    navigate('/batch-calculator');
  }

  const selected = selectedFormula;
  const inventory = getInventory();

  return (
    <div className="main-container">
      {/* Left: Folder tree */}
      <div className="items-panel">
        <div className="items-header">
          <input
            type="text"
            className="search-box"
            placeholder="Search formulas..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-label">Formulas</div>
              <div className="stat-value">{formulas.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Clients</div>
              <div className="stat-value">{sortedClients.filter(c => c !== 'Uncategorized').length}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button className="btn btn-small" onClick={expandAll} style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}>Expand All</button>
            <button className="btn btn-small" onClick={collapseAll} style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}>Collapse All</button>
          </div>
        </div>

        <div className="items-list" style={{ padding: 8, gap: 6, display: 'flex', flexDirection: 'column' }}>
          {filtered.map(client => {
            const clientFormulas = groups[client].filter(f =>
              !searchQuery || client.toLowerCase().includes(searchQuery.toLowerCase()) ||
              f.name.toLowerCase().includes(searchQuery.toLowerCase())
            );
            const isExpanded = expandedFolders[client];
            const isUncategorized = client === 'Uncategorized';
            const isDragOver = dragOverClient === client;

            return (
              <div
                key={client}
                onDragOver={(e) => { e.preventDefault(); setDragOverClient(client); }}
                onDragLeave={() => setDragOverClient(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverClient(null);
                  if (draggedIdx !== null) {
                    moveFormula(draggedIdx, client);
                    setDraggedIdx(null);
                  }
                }}
              >
                {/* Folder header */}
                <div
                  onClick={() => toggleFolder(client)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '10px 12px', borderRadius: 6, cursor: 'pointer', userSelect: 'none',
                    background: isDragOver ? '#dbeafe' : (isUncategorized ? '#f9fafb' : '#eff6ff'),
                    border: `1px solid ${isDragOver ? '#2563eb' : (isUncategorized ? '#e5e7eb' : '#bfdbfe')}`,
                    outline: isDragOver ? '2px solid #2563eb' : 'none',
                    transition: 'all 0.15s',
                  }}
                >
                  <span style={{
                    fontSize: 10, color: '#6b7280',
                    transform: isExpanded ? 'rotate(90deg)' : 'rotate(0)',
                    transition: 'transform 0.2s', display: 'inline-block',
                  }}>&#9654;</span>
                  <span style={{ fontSize: 16 }}>{isExpanded ? '📂' : '📁'}</span>
                  <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{client}</span>
                  <span style={{
                    fontSize: 11, color: '#6b7280', background: 'white',
                    padding: '2px 8px', borderRadius: 10, border: '1px solid #e5e7eb',
                  }}>{clientFormulas.length}</span>
                </div>

                {/* Folder contents */}
                {isExpanded && (
                  <div style={{ paddingLeft: 16, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {clientFormulas.map(formula => {
                      const date = new Date(formula.updatedAt || formula.createdAt || formula.savedAt);
                      const dateStr = date.toLocaleDateString();
                      const isActive = selected?._index === formula._index;
                      return (
                        <div
                          key={formula._index}
                          draggable
                          onDragStart={() => setDraggedIdx(formula._index)}
                          onDragEnd={() => setDraggedIdx(null)}
                          onClick={() => setSelectedFormula(formula)}
                          style={{
                            padding: '8px 10px', borderRadius: 6, cursor: 'grab',
                            border: `1px solid ${isActive ? '#2563eb' : '#e5e7eb'}`,
                            background: isActive ? '#eff6ff' : 'white',
                            transition: 'all 0.15s',
                            opacity: draggedIdx === formula._index ? 0.4 : 1,
                          }}
                        >
                          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {formula.name}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div style={{ fontSize: 11, color: '#6b7280' }}>
                              {(formula.ingredients || []).length} ingredients &middot; {dateStr}
                            </div>
                            <span
                              title="Rename formula"
                              onClick={(e) => { e.stopPropagation(); renameFormula(formula._index); }}
                              style={{ fontSize: 11, color: '#6b7280', cursor: 'pointer', padding: '0 4px', borderRadius: 3, hover: { background: '#f3f4f6' } }}
                            >✏️</span>
                          </div>
                        </div>
                      );
                    })}
                    {/* Folder action buttons */}
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <button
                        className="btn btn-small"
                        onClick={(e) => { e.stopPropagation(); addFormulaToClient(client); }}
                        style={{ flex: 1, fontSize: 11, justifyContent: 'center', color: '#2563eb' }}
                      >
                        + New Formula
                      </button>
                      {!isUncategorized && (
                        <button
                          className="btn btn-small"
                          onClick={(e) => { e.stopPropagation(); renameClient(client); }}
                          style={{ flex: 1, fontSize: 11, justifyContent: 'center', color: '#6b7280' }}
                        >
                          Rename Folder
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="items-panel-footer" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button className="btn btn-primary" onClick={addFolder} style={{ width: '100%', justifyContent: 'center' }}>
            + New Client Folder
          </button>
          <button className="btn" onClick={() => fileInputRef.current?.click()} style={{ width: '100%', justifyContent: 'center' }}>
            Import Formula JSON
          </button>
          <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={importFormula} />
        </div>
      </div>

      {/* Right: Formula detail */}
      <div className="detail-panel">
        {!selected ? (
          <div className="detail-panel-empty">
            <div className="detail-panel-empty-icon" style={{ fontSize: 48 }}>📋</div>
            <div>Select a formula to view details</div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 8 }}>
              Drag formulas between folders to reorganize
            </div>
          </div>
        ) : (
          <div style={{ padding: 24 }}>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>{selected.name}</div>
              <div style={{ fontSize: 13, color: '#6b7280' }}>
                Client: <strong>{selected.client || 'Uncategorized'}</strong>
                &nbsp;&middot;&nbsp;
                {selected.baseYield} {selected.baseYieldUnit} base yield
                &nbsp;&middot;&nbsp;
                {selected.batchSize} {selected.batchSizeUnit} batch
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-small" onClick={() => loadInBatchCalc(selected)}>
                Open in Batch Calculator
              </button>
              <button className="btn btn-small" onClick={() => renameFormula(selected._index)}>
                Rename
              </button>
              <button className="btn btn-small" onClick={() => duplicateFormula(selected._index)}>
                Duplicate
              </button>
              <button className="btn btn-small" onClick={() => exportFormula(selected)}>
                Export JSON
              </button>
              <button className="btn btn-small btn-danger" onClick={() => removeFormula(selected._index)}>
                Delete
              </button>
            </div>

            {/* Ingredients table */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>
                Ingredients ({(selected.ingredients || []).length})
              </div>
              {(selected.ingredients || []).length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af', fontSize: 13, background: '#f9fafb', borderRadius: 6 }}>
                  No ingredients in this formula
                </div>
              ) : (
                <table style={{ fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th>Ingredient</th>
                      <th>Type</th>
                      <th>Recipe Amt</th>
                      <th>Buy Unit</th>
                      <th>Price</th>
                      <th>MOQ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selected.ingredients || []).map((ing, i) => {
                      const inv = inventory.find(item => item.id === ing.inventoryId);
                      return (
                        <tr key={i}>
                          <td style={{ fontWeight: 600 }}>{inv?.name || ing.draftName || ing.name || 'Unknown'}</td>
                          <td>{ing.type}</td>
                          <td>{ing.recipeAmount} {ing.recipeUnit}</td>
                          <td>{ing.buyUnit}</td>
                          <td>${(ing.pricePerBuyUnit || 0).toFixed(4)}</td>
                          <td>{ing.moq || 1}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Version History link */}
            <div style={{ marginBottom: 20 }}>
              {(selected.versions || []).length > 0 ? (
                <button
                  className="btn btn-small"
                  onClick={() => setVersionModal({ formulaIndex: selected._index, versions: selected.versions || [] })}
                  style={{ fontSize: 12, color: '#6b7280' }}
                >
                  Version History ({(selected.versions || []).length})
                </button>
              ) : (
                <div style={{ fontSize: 11, color: '#9ca3af' }}>No version history yet — versions are created each time you save changes</div>
              )}
            </div>

            {/* Metadata */}
            <div style={{ fontSize: 11, color: '#9ca3af' }}>
              {selected.createdAt && <div>Created: {new Date(selected.createdAt).toLocaleString()}</div>}
              {selected.updatedAt && <div>Modified: {new Date(selected.updatedAt).toLocaleString()}</div>}
              {selected.savedAt && !selected.createdAt && <div>Saved: {new Date(selected.savedAt).toLocaleString()}</div>}
              {selected.id && <div style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 10 }}>ID: {selected.id}</div>}
            </div>
          </div>
        )}
      </div>

      {/* Version History Modal */}
      {versionModal && (() => {
        const formula = formulas[versionModal.formulaIndex];
        if (!formula) return null;
        const versions = formula.versions || [];
        return (
          <div
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
            }}
            onClick={() => setVersionModal(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'white', borderRadius: 12, width: '90%', maxWidth: 520,
                maxHeight: '80vh', display: 'flex', flexDirection: 'column',
                boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
              }}
            >
              {/* Modal header */}
              <div style={{
                padding: '20px 24px', borderBottom: '1px solid #e5e7eb',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>Version History</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{formula.name}</div>
                </div>
                <button
                  onClick={() => setVersionModal(null)}
                  style={{
                    background: 'none', border: 'none', fontSize: 20, cursor: 'pointer',
                    color: '#6b7280', padding: '4px 8px', borderRadius: 4,
                  }}
                >&times;</button>
              </div>

              {/* Version list */}
              <div style={{ padding: '16px 24px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Current */}
                <div style={{
                  padding: '12px 14px', borderRadius: 8,
                  background: '#f0fdf4', border: '1px solid #bbf7d0',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#16a34a' }}>
                      v{versions.length + 1} (Current)
                    </span>
                    <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 600 }}>Active</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>
                    {formula.updatedAt ? new Date(formula.updatedAt).toLocaleString() : 'Now'}
                    &nbsp;&middot;&nbsp;{(formula.ingredients || []).length} ingredients
                  </div>
                </div>

                {/* Previous versions newest first */}
                {[...versions].reverse().map((ver, ri) => {
                  const vIdx = versions.length - 1 - ri;
                  return (
                    <div key={vIdx} style={{
                      padding: '12px 14px', borderRadius: 8,
                      background: '#f9fafb', border: '1px solid #e5e7eb',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
                          {ver.versionLabel || `v${vIdx + 1}`}
                        </span>
                        <button
                          className="btn btn-small"
                          onClick={() => {
                            restoreVersion(versionModal.formulaIndex, vIdx);
                            setVersionModal(null);
                          }}
                          style={{ fontSize: 11, padding: '3px 12px' }}
                        >
                          Restore
                        </button>
                      </div>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>
                        {ver.versionDate ? new Date(ver.versionDate).toLocaleString() : '—'}
                        &nbsp;&middot;&nbsp;{(ver.ingredients || []).length} ingredients
                        {ver.name !== formula.name && <span>&nbsp;&middot;&nbsp;was &ldquo;{ver.name}&rdquo;</span>}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Modal footer */}
              <div style={{ padding: '16px 24px', borderTop: '1px solid #e5e7eb', textAlign: 'right' }}>
                <button className="btn btn-small" onClick={() => setVersionModal(null)}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
