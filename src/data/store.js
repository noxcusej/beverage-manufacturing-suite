import {
  defaultInventory,
  defaultPackaging,
  defaultServices,
  defaultVendors,
  defaultTankConfig,
  defaultGlobalSettings,
} from './defaults';
import {
  loadAppData,
  saveAppData,
  loadFormulasFromSupabase,
  saveFormulaToSupabase,
  syncAllFormulasToSupabase,
  deleteFormulaFromSupabase,
} from './supabase';

// ── In-memory cache (replaces localStorage) ──

const _cache = {
  inventory: null,
  packaging: null,
  services: null,
  vendors: null,
  formulas: null,
  currentBatch: null,
  tankConfig: null,
  runs: null,
  clients: null,
  missionControl: null,
  finishedGoods: null,
  savedPOs: null,
  globalSettings: null,
};

const _defaults = {
  inventory: defaultInventory,
  packaging: defaultPackaging,
  services: defaultServices,
  vendors: defaultVendors,
  formulas: [],
  currentBatch: null,
  tankConfig: defaultTankConfig,
  runs: [],
  clients: [],
  missionControl: { tasks: [], cronJobs: [], team: [], officeStatus: [] },
  finishedGoods: [],
  savedPOs: [],
  globalSettings: defaultGlobalSettings,
};

let _hydrated = false;

// Map camelCase domain names to snake_case Supabase keys
const _keyMap = {
  inventory: 'inventory',
  packaging: 'packaging',
  services: 'services',
  vendors: 'vendors',
  runs: 'runs',
  clients: 'clients',
  tankConfig: 'tank_config',
  currentBatch: 'current_batch',
  missionControl: 'mission_control',
  finishedGoods: 'finished_goods',
  savedPOs: 'saved_pos',
  globalSettings: 'global_settings',
};

function notify(dataType) {
  window.dispatchEvent(
    new CustomEvent('comanufacturing:datachange', { detail: { dataType } })
  );
}

function get(domain) {
  return _cache[domain] ?? _defaults[domain];
}

function set(domain, value) {
  _cache[domain] = value;
  notify(domain);
  // Write-through to Supabase (async, non-blocking)
  if (domain !== 'formulas') {
    const dbKey = _keyMap[domain] || domain;
    saveAppData(dbKey, value).catch(err =>
      console.error(`[Store] Supabase write-through failed for ${domain}:`, err)
    );
  }
}

// ── Initialization ──

export function initStore() {
  // Seed cache with defaults (will be overwritten by hydrate)
  Object.keys(_defaults).forEach(key => {
    if (_cache[key] === null) _cache[key] = _defaults[key];
  });
}

/**
 * Hydrate all data from Supabase. Call once on app init.
 * Returns when all domains have been loaded.
 */
export async function hydrateAll() {
  if (_hydrated) return;

  const domains = Object.keys(_keyMap);

  await Promise.allSettled(
    domains.map(async (domain) => {
      const remote = await loadAppData(_keyMap[domain]);
      if (remote !== null && remote !== undefined) {
        // For arrays, only use remote if it has data (or is explicitly empty)
        _cache[domain] = remote;
        notify(domain);
      } else {
        // Supabase returned null — push defaults up
        const current = get(domain);
        if (current && (Array.isArray(current) ? current.length > 0 : true)) {
          saveAppData(_keyMap[domain], current).catch(() => {});
        }
      }
    })
  );

  // Hydrate formulas separately (uses dedicated table)
  await hydrateFormulasFromSupabase();

  _hydrated = true;
}

// ── Inventory ──

export function getInventory() {
  return get('inventory');
}

export function saveInventory(inventory) {
  set('inventory', inventory);
}

export function getInventoryItem(id) {
  return getInventory().find((item) => item.id === id);
}

export function updateInventoryItem(id, updates) {
  const inventory = [...getInventory()];
  const index = inventory.findIndex((item) => item.id === id);
  if (index !== -1) {
    inventory[index] = { ...inventory[index], ...updates };
    saveInventory(inventory);
  }
}

export function addInventoryItem(item) {
  const inventory = [...getInventory()];
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
  return get('packaging');
}

export function savePackaging(packaging) {
  set('packaging', packaging);
}

export function addPackagingItem(item) {
  const packaging = [...getPackaging()];
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
  return get('services');
}

export function saveServices(services) {
  set('services', services);
}

export function addService(service) {
  const services = [...getServices()];
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
  return get('vendors');
}

export function saveVendors(vendors) {
  set('vendors', vendors);
}

export function getVendor(id) {
  return getVendors().find((v) => v.id === id);
}

// ── Finished Goods ──
// { id, name, pack: [{ formulaId, units }], packsPerCase, casesPerPallet }

export function getFinishedGoods() {
  return get('finishedGoods');
}

export function saveFinishedGoods(list) {
  set('finishedGoods', list);
}

export function upsertFinishedGood(fg) {
  const list = [...getFinishedGoods()];
  const i = list.findIndex((x) => x.id === fg.id);
  if (i >= 0) list[i] = fg;
  else list.push(fg);
  saveFinishedGoods(list);
}

export function deleteFinishedGood(id) {
  saveFinishedGoods(getFinishedGoods().filter((x) => x.id !== id));
}

// ── Saved POs ──
// { id, name, createdAt, fgSelections: [{ fgId, qty, level }] }

export function getSavedPOs() {
  return get('savedPOs');
}

export function saveSavedPOs(list) {
  set('savedPOs', list);
}

export function upsertSavedPO(po) {
  const list = [...getSavedPOs()];
  const i = list.findIndex((x) => x.id === po.id);
  if (i >= 0) list[i] = po;
  else list.push(po);
  saveSavedPOs(list);
}

export function deleteSavedPO(id) {
  saveSavedPOs(getSavedPOs().filter((x) => x.id !== id));
}

// ── Formulas (dedicated Supabase table) ──

function generateFormulaId() {
  return 'FRM-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
}

let _formulasLoaded = false;

export function getFormulas() {
  const formulas = get('formulas');
  let changed = false;
  formulas.forEach(f => {
    if (!f.id) { f.id = generateFormulaId(); changed = true; }
  });
  if (changed) {
    _cache.formulas = formulas;
  }
  return formulas;
}

export async function hydrateFormulasFromSupabase() {
  if (_formulasLoaded) return getFormulas();
  try {
    const remote = await loadFormulasFromSupabase();
    if (remote && remote.length > 0) {
      _cache.formulas = remote;
      _formulasLoaded = true;
      notify('formulas');
      return remote;
    } else if (remote !== null) {
      _formulasLoaded = true;
    }
  } catch (err) {
    console.error('[Store] hydrateFormulas error:', err);
  }
  return getFormulas();
}

export function saveFormula(formula) {
  const formulas = [...getFormulas()];
  const now = new Date().toISOString();

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
    savedFormula = {
      ...formula,
      id: formula.id || generateFormulaId(),
      versions: [],
      createdAt: now,
      updatedAt: now,
    };
    formulas.push(savedFormula);
  }

  _cache.formulas = formulas;
  notify('formulas');

  // Write-through to Supabase
  saveFormulaToSupabase(savedFormula).catch(err =>
    console.error('[Store] Supabase write-through failed:', err)
  );
}

export function saveAllFormulas(formulas) {
  _cache.formulas = formulas;
  notify('formulas');
  syncAllFormulasToSupabase(formulas).catch(err =>
    console.error('[Store] Supabase bulk sync failed:', err)
  );
}

export function deleteFormula(formulaId) {
  _cache.formulas = getFormulas().filter(f => f.id !== formulaId);
  notify('formulas');
  deleteFormulaFromSupabase(formulaId).catch(err =>
    console.error('[Store] Supabase delete failed:', err)
  );
}

// ── Batch ──

export function getCurrentBatch() {
  return get('currentBatch');
}

export function saveBatch(batchData) {
  const batch = { ...batchData, timestamp: new Date().toISOString() };
  set('currentBatch', batch);
  return batch;
}

export function clearBatch() {
  set('currentBatch', null);
}

// ── Tank Config ──

export function getTankConfig() {
  return get('tankConfig');
}

export function saveTankConfig(tanks) {
  set('tankConfig', tanks);
}

// ── Global Settings ──

export function getGlobalSettings() {
  return get('globalSettings');
}

export function saveGlobalSettings(settings) {
  set('globalSettings', { ...getGlobalSettings(), ...settings });
}

// ── Runs ──

export function getRuns() {
  return get('runs');
}

export function saveRun(run) {
  const runs = [...getRuns()];
  const now = new Date().toISOString();
  const existing = runs.findIndex((r) => r.id === run.id);
  if (existing !== -1) {
    runs[existing] = { ...run, updatedAt: now };
  } else {
    runs.push({ ...run, id: run.id || 'RUN-' + Date.now(), createdAt: now, updatedAt: now });
  }
  set('runs', runs);
  return runs[existing !== -1 ? existing : runs.length - 1];
}

export function deleteRun(runId) {
  set('runs', getRuns().filter((r) => r.id !== runId));
}

// ── Clients ──

export function getClients() {
  return get('clients');
}

export function saveClient(client) {
  const clients = [...getClients()];
  const now = new Date().toISOString();
  const existing = clients.findIndex((c) => c.id === client.id);
  if (existing !== -1) {
    clients[existing] = { ...clients[existing], ...client, updatedAt: now };
  } else {
    clients.push({ ...client, id: client.id || 'CLT-' + Date.now(), createdAt: now, updatedAt: now });
  }
  set('clients', clients);
  return clients[existing !== -1 ? existing : clients.length - 1];
}

export function deleteClient(clientId) {
  set('clients', getClients().filter((c) => c.id !== clientId));
}

export function getFormulasForClient(clientName) {
  return getFormulas().filter((f) => (f.client || '') === clientName);
}

export function getRunsForClient(clientName) {
  return getRuns().filter((r) => (r.client || '') === clientName);
}

// ── Mission Control ──

export function getMissionControlState() {
  return get('missionControl');
}

export function saveMissionControlState(state) {
  set('missionControl', {
    tasks: state.tasks,
    cronJobs: state.cronJobs,
    team: state.team,
    officeStatus: state.officeStatus,
  });
}
