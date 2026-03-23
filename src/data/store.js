import {
  defaultInventory,
  defaultPackaging,
  defaultServices,
  defaultVendors,
  defaultTankConfig,
} from './defaults';
import {
  loadFormulasFromSupabase,
  saveFormulaToSupabase,
  syncAllFormulasToSupabase,
  deleteFormulaFromSupabase,
} from './supabase';

const STORAGE_KEYS = {
  inventory: 'comanufacturing_inventory',
  packaging: 'comanufacturing_packaging',
  services: 'comanufacturing_services',
  vendors: 'comanufacturing_vendors',
  formulas: 'comanufacturing_formulas',
  currentBatch: 'comanufacturing_current_batch',
  tankConfig: 'comanufacturing_tank_config',
  runs: 'comanufacturing_runs',
  clients: 'comanufacturing_clients',
  missionControl: 'openclaw_mission_control',
};

function load(key, fallback) {
  const data = localStorage.getItem(key);
  return data ? JSON.parse(data) : fallback;
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(
    new CustomEvent('comanufacturing:datachange', { detail: { dataType: key } })
  );
}

// Initialize defaults if not present
export function initStore() {
  if (!localStorage.getItem(STORAGE_KEYS.inventory)) {
    save(STORAGE_KEYS.inventory, defaultInventory);
  }
  if (!localStorage.getItem(STORAGE_KEYS.packaging)) {
    save(STORAGE_KEYS.packaging, defaultPackaging);
  }
  if (!localStorage.getItem(STORAGE_KEYS.services)) {
    save(STORAGE_KEYS.services, defaultServices);
  }
  if (!localStorage.getItem(STORAGE_KEYS.vendors)) {
    save(STORAGE_KEYS.vendors, defaultVendors);
  }
}

// ── Inventory ──

export function getInventory() {
  return load(STORAGE_KEYS.inventory, defaultInventory);
}

export function saveInventory(inventory) {
  save(STORAGE_KEYS.inventory, inventory);
}

export function getInventoryItem(id) {
  return getInventory().find((item) => item.id === id);
}

export function updateInventoryItem(id, updates) {
  const inventory = getInventory();
  const index = inventory.findIndex((item) => item.id === id);
  if (index !== -1) {
    inventory[index] = { ...inventory[index], ...updates };
    saveInventory(inventory);
  }
}

export function addInventoryItem(item) {
  const inventory = getInventory();
  const newId = 'INV-' + String(inventory.length + 1).padStart(3, '0');
  inventory.push({ ...item, id: newId });
  saveInventory(inventory);
  return newId;
}

export function deleteInventoryItem(id) {
  saveInventory(getInventory().filter((item) => item.id !== id));
}

export function getInventoryPrice(id, quantity) {
  const item = getInventoryItem(id);
  if (!item?.priceTiers?.length) {
    return { price: 0, buyUnit: 'gal', moq: 1, setupFee: 0 };
  }
  for (const tier of item.priceTiers) {
    if (quantity >= tier.minQty && (tier.maxQty === null || quantity <= tier.maxQty)) {
      return { price: tier.price, buyUnit: tier.buyUnit, moq: tier.moq, setupFee: tier.setupFee || 0 };
    }
  }
  const first = item.priceTiers[0];
  return { price: first.price, buyUnit: first.buyUnit, moq: first.moq, setupFee: first.setupFee || 0 };
}

// ── Packaging ──

export function getPackaging() {
  return load(STORAGE_KEYS.packaging, defaultPackaging);
}

export function savePackaging(packaging) {
  save(STORAGE_KEYS.packaging, packaging);
}

export function addPackagingItem(item) {
  const packaging = getPackaging();
  const newId = 'PKG-' + String(packaging.length + 1).padStart(3, '0');
  packaging.push({ ...item, id: newId });
  savePackaging(packaging);
  return newId;
}

export function deletePackagingItem(id) {
  savePackaging(getPackaging().filter((item) => item.id !== id));
}

export function getPackagingPrice(id, quantity) {
  const items = getPackaging();
  const item = items.find((p) => p.id === id);
  if (!item?.priceTiers?.length) {
    return { price: 0, moq: 1, setupFee: 0 };
  }
  for (const tier of item.priceTiers) {
    if (quantity >= tier.minQty && (tier.maxQty === null || quantity <= tier.maxQty)) {
      return { price: tier.price, moq: tier.minQty, setupFee: tier.setupFee || 0 };
    }
  }
  const first = item.priceTiers[0];
  return { price: first.price, moq: first.minQty, setupFee: first.setupFee || 0 };
}

// ── Services ──

export function getServices() {
  return load(STORAGE_KEYS.services, defaultServices);
}

export function saveServices(services) {
  save(STORAGE_KEYS.services, services);
}

export function addService(service) {
  const services = getServices();
  const newId = 'SVC-' + String(services.length + 1).padStart(3, '0');
  services.push({ ...service, id: newId });
  saveServices(services);
  return newId;
}

export function deleteService(id) {
  saveServices(getServices().filter((item) => item.id !== id));
}

// ── Vendors ──

export function getVendors() {
  return load(STORAGE_KEYS.vendors, defaultVendors);
}

export function saveVendors(vendors) {
  save(STORAGE_KEYS.vendors, vendors);
}

export function getVendor(id) {
  return getVendors().find((v) => v.id === id);
}

// ── Formulas ──

function generateFormulaId() {
  return 'FRM-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
}

// Track whether we've loaded from Supabase this session
let _supabaseLoaded = false;

export function getFormulas() {
  const formulas = load(STORAGE_KEYS.formulas, []);
  // Backfill IDs for any formulas that don't have one
  let changed = false;
  formulas.forEach(f => {
    if (!f.id) { f.id = generateFormulaId(); changed = true; }
  });
  if (changed) {
    localStorage.setItem(STORAGE_KEYS.formulas, JSON.stringify(formulas));
  }
  return formulas;
}

/**
 * Load formulas from Supabase and merge into localStorage.
 * Call this once on app init to hydrate from the database.
 */
export async function hydrateFormulasFromSupabase() {
  if (_supabaseLoaded) return getFormulas();
  try {
    const remote = await loadFormulasFromSupabase();
    if (remote && remote.length > 0) {
      const local = getFormulas();
      // Merge: remote wins on conflict (by ID), keep local-only formulas
      const remoteIds = new Set(remote.map(f => f.id));
      const localOnly = local.filter(f => !remoteIds.has(f.id));
      const merged = [...remote, ...localOnly];
      localStorage.setItem(STORAGE_KEYS.formulas, JSON.stringify(merged));
      _supabaseLoaded = true;

      // Push any local-only formulas up to Supabase
      if (localOnly.length > 0) {
        syncAllFormulasToSupabase(localOnly).catch(() => {});
      }

      window.dispatchEvent(
        new CustomEvent('comanufacturing:datachange', { detail: { dataType: 'formulas' } })
      );
      return merged;
    } else if (remote !== null) {
      // Supabase returned empty — push local formulas up
      const local = getFormulas();
      if (local.length > 0) {
        syncAllFormulasToSupabase(local).catch(() => {});
      }
      _supabaseLoaded = true;
    }
  } catch (err) {
    console.error('[Store] hydrateFormulas error:', err);
  }
  return getFormulas();
}

export function saveFormula(formula) {
  const formulas = getFormulas();
  const now = new Date().toISOString();

  // Match by ID first, then fallback to name
  let existingIdx = -1;
  if (formula.id) {
    existingIdx = formulas.findIndex((f) => f.id === formula.id);
  }
  if (existingIdx === -1) {
    existingIdx = formulas.findIndex((f) => f.name === formula.name);
  }

  let savedFormula;
  if (existingIdx !== -1) {
    const old = formulas[existingIdx];
    const versions = old.versions || [];

    // Only create a version if data actually changed
    // (skip if last save was within 2 seconds — dedup rapid double-calls)
    const lastVer = versions[versions.length - 1];
    const skipVersion = lastVer && (new Date(now) - new Date(lastVer.versionDate)) < 2000;

    if (!skipVersion) {
      const snapshot = { ...old };
      delete snapshot.versions;
      snapshot.versionDate = now;
      snapshot.versionLabel = 'v' + (versions.length + 1);
      versions.push(snapshot);
    }

    formulas[existingIdx] = {
      ...formula,
      id: old.id,
      versions: versions,
      createdAt: old.createdAt,
      updatedAt: now,
    };
    savedFormula = formulas[existingIdx];
  } else {
    // New formula
    savedFormula = {
      ...formula,
      id: formula.id || generateFormulaId(),
      versions: [],
      createdAt: now,
      updatedAt: now,
    };
    formulas.push(savedFormula);
  }

  // Write to localStorage
  localStorage.setItem(STORAGE_KEYS.formulas, JSON.stringify(formulas));
  window.dispatchEvent(
    new CustomEvent('comanufacturing:datachange', { detail: { dataType: 'formulas' } })
  );

  // Write-through to Supabase (async, non-blocking)
  saveFormulaToSupabase(savedFormula).catch(err =>
    console.error('[Store] Supabase write-through failed:', err)
  );
}

/**
 * Save all formulas (used by FormulaLibrary for bulk ops like rename, delete, reorder).
 * Also syncs to Supabase.
 */
export function saveAllFormulas(formulas) {
  localStorage.setItem(STORAGE_KEYS.formulas, JSON.stringify(formulas));
  window.dispatchEvent(
    new CustomEvent('comanufacturing:datachange', { detail: { dataType: 'formulas' } })
  );
  // Sync full set to Supabase
  syncAllFormulasToSupabase(formulas).catch(err =>
    console.error('[Store] Supabase bulk sync failed:', err)
  );
}

/**
 * Delete a formula by ID from both localStorage and Supabase.
 */
export function deleteFormula(formulaId) {
  const formulas = getFormulas().filter(f => f.id !== formulaId);
  localStorage.setItem(STORAGE_KEYS.formulas, JSON.stringify(formulas));
  window.dispatchEvent(
    new CustomEvent('comanufacturing:datachange', { detail: { dataType: 'formulas' } })
  );
  deleteFormulaFromSupabase(formulaId).catch(err =>
    console.error('[Store] Supabase delete failed:', err)
  );
}

// ── Batch ──

export function getCurrentBatch() {
  return load(STORAGE_KEYS.currentBatch, null);
}

export function saveBatch(batchData) {
  const batch = { ...batchData, timestamp: new Date().toISOString() };
  save(STORAGE_KEYS.currentBatch, batch);
  return batch;
}

export function clearBatch() {
  localStorage.removeItem(STORAGE_KEYS.currentBatch);
}

// ── Tank Config ──

export function getTankConfig() {
  return load(STORAGE_KEYS.tankConfig, defaultTankConfig);
}

export function saveTankConfig(tanks) {
  save(STORAGE_KEYS.tankConfig, tanks);
}

// ── Runs ──

export function getRuns() {
  return load(STORAGE_KEYS.runs, []);
}

export function saveRun(run) {
  const runs = getRuns();
  const now = new Date().toISOString();
  const existing = runs.findIndex((r) => r.id === run.id);
  if (existing !== -1) {
    runs[existing] = { ...run, updatedAt: now };
  } else {
    runs.push({ ...run, id: run.id || 'RUN-' + Date.now(), createdAt: now, updatedAt: now });
  }
  save(STORAGE_KEYS.runs, runs);
  return runs[existing !== -1 ? existing : runs.length - 1];
}

export function deleteRun(runId) {
  save(STORAGE_KEYS.runs, getRuns().filter((r) => r.id !== runId));
}

// ── Clients ──

export function getClients() {
  return load(STORAGE_KEYS.clients, []);
}

export function saveClient(client) {
  const clients = getClients();
  const now = new Date().toISOString();
  const existing = clients.findIndex((c) => c.id === client.id);
  if (existing !== -1) {
    clients[existing] = { ...clients[existing], ...client, updatedAt: now };
  } else {
    clients.push({ ...client, id: client.id || 'CLT-' + Date.now(), createdAt: now, updatedAt: now });
  }
  save(STORAGE_KEYS.clients, clients);
  return clients[existing !== -1 ? existing : clients.length - 1];
}

export function deleteClient(clientId) {
  save(STORAGE_KEYS.clients, getClients().filter((c) => c.id !== clientId));
}

export function getFormulasForClient(clientName) {
  return getFormulas().filter((f) => (f.client || '') === clientName);
}

export function getRunsForClient(clientName) {
  return getRuns().filter((r) => (r.client || '') === clientName);
}

// ── Mission Control ──

export function getMissionControlState() {
  return load(STORAGE_KEYS.missionControl, { tasks: [], cronJobs: [], team: [], officeStatus: [] });
}

export function saveMissionControlState(state) {
  save(STORAGE_KEYS.missionControl, {
    tasks: state.tasks,
    cronJobs: state.cronJobs,
    team: state.team,
    officeStatus: state.officeStatus,
  });
}
