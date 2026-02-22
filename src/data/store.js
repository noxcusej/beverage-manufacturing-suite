import {
  defaultInventory,
  defaultPackaging,
  defaultServices,
  defaultVendors,
  defaultTankConfig,
} from './defaults';

const STORAGE_KEYS = {
  inventory: 'comanufacturing_inventory',
  packaging: 'comanufacturing_packaging',
  services: 'comanufacturing_services',
  vendors: 'comanufacturing_vendors',
  formulas: 'comanufacturing_formulas',
  currentBatch: 'comanufacturing_current_batch',
  tankConfig: 'comanufacturing_tank_config',
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

export function getFormulas() {
  return load(STORAGE_KEYS.formulas, []);
}

export function saveFormula(formula) {
  const formulas = getFormulas();
  const existing = formulas.findIndex((f) => f.name === formula.name);
  if (existing !== -1) {
    formulas[existing] = { ...formula, updatedAt: new Date().toISOString() };
  } else {
    formulas.push({ ...formula, createdAt: new Date().toISOString() });
  }
  localStorage.setItem(STORAGE_KEYS.formulas, JSON.stringify(formulas));
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
