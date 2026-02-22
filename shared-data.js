// Co-Manufacturing Calculator - Shared Data Layer
// This file provides a unified data model and storage system across all pages

const CoManufacturing = {
    // Storage keys
    STORAGE_KEYS: {
        inventory: 'comanufacturing_inventory',
        packaging: 'comanufacturing_packaging',
        services: 'comanufacturing_services',
        vendors: 'comanufacturing_vendors',
        formulas: 'comanufacturing_formulas',
        currentBatch: 'comanufacturing_current_batch',
        tankConfig: 'comanufacturing_tank_config'
    },

    // Initialize data with defaults if not present
    init() {
        if (!localStorage.getItem(this.STORAGE_KEYS.inventory)) {
            this.saveInventory(this.getDefaultInventory());
        }
        if (!localStorage.getItem(this.STORAGE_KEYS.packaging)) {
            this.savePackaging(this.getDefaultPackaging());
        }
        if (!localStorage.getItem(this.STORAGE_KEYS.services)) {
            this.saveServices(this.getDefaultServices());
        }
        if (!localStorage.getItem(this.STORAGE_KEYS.vendors)) {
            this.saveVendors(this.getDefaultVendors());
        }
    },

    // Inventory methods
    getInventory() {
        const data = localStorage.getItem(this.STORAGE_KEYS.inventory);
        return data ? JSON.parse(data) : this.getDefaultInventory();
    },

    saveInventory(inventory) {
        localStorage.setItem(this.STORAGE_KEYS.inventory, JSON.stringify(inventory));
        this.notifyChange('inventory');
    },

    getInventoryItem(id) {
        const inventory = this.getInventory();
        return inventory.find(item => item.id === id);
    },

    updateInventoryItem(id, updates) {
        const inventory = this.getInventory();
        const index = inventory.findIndex(item => item.id === id);
        if (index !== -1) {
            inventory[index] = { ...inventory[index], ...updates };
            this.saveInventory(inventory);
        }
    },

    addInventoryItem(item) {
        const inventory = this.getInventory();
        const newId = 'INV-' + String(inventory.length + 1).padStart(3, '0');
        inventory.push({ ...item, id: newId });
        this.saveInventory(inventory);
        return newId;
    },

    deleteInventoryItem(id) {
        const inventory = this.getInventory();
        const filtered = inventory.filter(item => item.id !== id);
        this.saveInventory(filtered);
    },

    // Get price for quantity (considering tiers)
    getInventoryPrice(id, quantity) {
        const item = this.getInventoryItem(id);
        if (!item || !item.priceTiers || item.priceTiers.length === 0) {
            return { price: 0, buyUnit: 'gal', moq: 1, setupFee: 0 };
        }

        // Find the appropriate tier
        for (const tier of item.priceTiers) {
            if (quantity >= tier.minQty && (tier.maxQty === null || quantity <= tier.maxQty)) {
                return {
                    price: tier.price,
                    buyUnit: tier.buyUnit,
                    moq: tier.moq,
                    setupFee: tier.setupFee || 0
                };
            }
        }

        // If no tier matches, use the first tier (lowest qty)
        const firstTier = item.priceTiers[0];
        return {
            price: firstTier.price,
            buyUnit: firstTier.buyUnit,
            moq: firstTier.moq,
            setupFee: firstTier.setupFee || 0
        };
    },

    // Packaging methods
    getPackaging() {
        const data = localStorage.getItem(this.STORAGE_KEYS.packaging);
        return data ? JSON.parse(data) : this.getDefaultPackaging();
    },

    savePackaging(packaging) {
        localStorage.setItem(this.STORAGE_KEYS.packaging, JSON.stringify(packaging));
        this.notifyChange('packaging');
    },

    getPackagingPrice(id, quantity) {
        const items = this.getPackaging();
        const item = items.find(p => p.id === id);
        if (!item || !item.priceTiers || item.priceTiers.length === 0) {
            return { price: 0, moq: 1, setupFee: 0 };
        }

        for (const tier of item.priceTiers) {
            if (quantity >= tier.minQty && (tier.maxQty === null || quantity <= tier.maxQty)) {
                return {
                    price: tier.price,
                    moq: tier.minQty,
                    setupFee: tier.setupFee || 0
                };
            }
        }

        const firstTier = item.priceTiers[0];
        return {
            price: firstTier.price,
            moq: firstTier.minQty,
            setupFee: firstTier.setupFee || 0
        };
    },

    addPackagingItem(item) {
        const packaging = this.getPackaging();
        const newId = 'PKG-' + String(packaging.length + 1).padStart(3, '0');
        packaging.push({ ...item, id: newId });
        this.savePackaging(packaging);
        return newId;
    },

    deletePackagingItem(id) {
        const packaging = this.getPackaging();
        const filtered = packaging.filter(item => item.id !== id);
        this.savePackaging(filtered);
    },

    // Services methods
    getServices() {
        const data = localStorage.getItem(this.STORAGE_KEYS.services);
        return data ? JSON.parse(data) : this.getDefaultServices();
    },

    saveServices(services) {
        localStorage.setItem(this.STORAGE_KEYS.services, JSON.stringify(services));
        this.notifyChange('services');
    },

    addService(service) {
        const services = this.getServices();
        const newId = 'SVC-' + String(services.length + 1).padStart(3, '0');
        services.push({ ...service, id: newId });
        this.saveServices(services);
        return newId;
    },

    deleteService(id) {
        const services = this.getServices();
        const filtered = services.filter(item => item.id !== id);
        this.saveServices(filtered);
    },

    // Vendors methods
    getVendors() {
        const data = localStorage.getItem(this.STORAGE_KEYS.vendors);
        return data ? JSON.parse(data) : this.getDefaultVendors();
    },

    saveVendors(vendors) {
        localStorage.setItem(this.STORAGE_KEYS.vendors, JSON.stringify(vendors));
        this.notifyChange('vendors');
    },

    getVendor(id) {
        const vendors = this.getVendors();
        return vendors.find(v => v.id === id);
    },

    // Formulas methods
    getFormulas() {
        const data = localStorage.getItem(this.STORAGE_KEYS.formulas);
        return data ? JSON.parse(data) : [];
    },

    saveFormula(formula) {
        const formulas = this.getFormulas();
        const existing = formulas.findIndex(f => f.name === formula.name);
        if (existing !== -1) {
            formulas[existing] = { ...formula, updatedAt: new Date().toISOString() };
        } else {
            formulas.push({ ...formula, createdAt: new Date().toISOString() });
        }
        localStorage.setItem(this.STORAGE_KEYS.formulas, JSON.stringify(formulas));
        this.notifyChange('formulas');
    },

    // Batch persistence methods
    getCurrentBatch() {
        const data = localStorage.getItem(this.STORAGE_KEYS.currentBatch);
        return data ? JSON.parse(data) : null;
    },

    saveBatch(batchData) {
        const batch = {
            ...batchData,
            timestamp: new Date().toISOString()
        };
        localStorage.setItem(this.STORAGE_KEYS.currentBatch, JSON.stringify(batch));
        this.notifyChange('currentBatch');
        return batch;
    },

    clearBatch() {
        localStorage.removeItem(this.STORAGE_KEYS.currentBatch);
        this.notifyChange('currentBatch');
    },

    // Tank configuration methods
    getTankConfig() {
        const data = localStorage.getItem(this.STORAGE_KEYS.tankConfig);
        return data ? JSON.parse(data) : this.getDefaultTankConfig();
    },

    saveTankConfig(tanks) {
        localStorage.setItem(this.STORAGE_KEYS.tankConfig, JSON.stringify(tanks));
        this.notifyChange('tankConfig');
    },

    getDefaultTankConfig() {
        return [
            { id: 'TNK-001', name: 'Tank 1', capacity: 500, unit: 'gal' },
            { id: 'TNK-002', name: 'Tank 2', capacity: 300, unit: 'gal' },
            { id: 'TNK-003', name: 'Tank 3', capacity: 200, unit: 'gal' }
        ];
    },

    // Change notification (for future reactive updates)
    notifyChange(dataType) {
        window.dispatchEvent(new CustomEvent('comanufacturing:datachange', { 
            detail: { dataType } 
        }));
    },

    // Default data
    getDefaultInventory() {
        return [
            {
                id: 'INV-001',
                sku: 'WTR-001',
                name: 'Filtered Water',
                vendorId: 'VND-001',
                type: 'liquid',
                currentStock: 5000,
                unit: 'gal',
                reorderPoint: 1000,
                specificGravity: 1.0,
                priceTiers: [
                    { minQty: 1, maxQty: 999, price: 0.005, buyUnit: 'gal', moq: 100, setupFee: 0 },
                    { minQty: 1000, maxQty: 4999, price: 0.004, buyUnit: 'gal', moq: 500, setupFee: 0 },
                    { minQty: 5000, maxQty: null, price: 0.003, buyUnit: 'gal', moq: 1000, setupFee: 0 }
                ]
            },
            {
                id: 'INV-002',
                sku: 'SUG-100',
                name: 'Cane Sugar',
                vendorId: 'VND-002',
                type: 'dry',
                currentStock: 2500,
                unit: 'lbs',
                reorderPoint: 500,
                specificGravity: 1.59,
                priceTiers: [
                    { minQty: 1, maxQty: 499, price: 0.75, buyUnit: 'lbs', moq: 50, setupFee: 0 },
                    { minQty: 500, maxQty: 1999, price: 0.68, buyUnit: 'lbs', moq: 100, setupFee: 0 },
                    { minQty: 2000, maxQty: null, price: 0.65, buyUnit: 'lbs', moq: 200, setupFee: 0 }
                ]
            },
            {
                id: 'INV-003',
                sku: 'CIT-205',
                name: 'Citric Acid',
                vendorId: 'VND-003',
                type: 'dry',
                currentStock: 85,
                unit: 'lbs',
                reorderPoint: 50,
                specificGravity: 1.665,
                priceTiers: [
                    { minQty: 1, maxQty: 99, price: 7.50, buyUnit: 'kg', moq: 11.34, setupFee: 0 },
                    { minQty: 100, maxQty: null, price: 6.50, buyUnit: 'kg', moq: 22.68, setupFee: 0 }
                ]
            },
            {
                id: 'INV-004',
                sku: 'FLV-301',
                name: 'Natural Citrus Flavor',
                vendorId: 'VND-004',
                type: 'liquid',
                currentStock: 12,
                unit: 'gal',
                reorderPoint: 5,
                specificGravity: 1.0,
                priceTiers: [
                    { minQty: 1, maxQty: 9, price: 95.00, buyUnit: 'gal', moq: 5, setupFee: 0 },
                    { minQty: 10, maxQty: null, price: 85.00, buyUnit: 'gal', moq: 10, setupFee: 0 }
                ]
            },
            {
                id: 'INV-005',
                sku: 'CAF-400',
                name: 'Caffeine Powder',
                vendorId: 'VND-005',
                type: 'dry',
                currentStock: 8,
                unit: 'lbs',
                reorderPoint: 5,
                specificGravity: 1.23,
                priceTiers: [
                    { minQty: 1, maxQty: null, price: 275.00, buyUnit: 'kg', moq: 2.27, setupFee: 0 }
                ]
            },
            {
                id: 'INV-006',
                sku: 'PRE-150',
                name: 'Sodium Benzoate',
                vendorId: 'VND-006',
                type: 'dry',
                currentStock: 42,
                unit: 'lbs',
                reorderPoint: 10,
                specificGravity: 1.44,
                priceTiers: [
                    { minQty: 1, maxQty: 99, price: 5.50, buyUnit: 'lbs', moq: 10, setupFee: 0 },
                    { minQty: 100, maxQty: null, price: 4.50, buyUnit: 'lbs', moq: 25, setupFee: 0 }
                ]
            }
        ];
    },

    getDefaultPackaging() {
        return [
            {
                id: 'PKG-001',
                name: '12oz Slim Can (202)',
                vendorId: 'VND-007',
                category: 'cans',
                unit: 'ea',
                priceTiers: [
                    { minQty: 10000, maxQty: 49999, price: 0.20, setupFee: 500 },
                    { minQty: 50000, maxQty: 99999, price: 0.19, setupFee: 500 },
                    { minQty: 100000, maxQty: null, price: 0.18, setupFee: 500 }
                ],
                leadTimeDays: 14,
                notes: 'Requires custom graphic setup'
            },
            {
                id: 'PKG-002',
                name: 'Shrink Sleeve Label',
                vendorId: 'VND-008',
                category: 'labels',
                unit: 'ea',
                priceTiers: [
                    { minQty: 5000, maxQty: 24999, price: 0.15, setupFee: 850 },
                    { minQty: 25000, maxQty: null, price: 0.12, setupFee: 850 }
                ],
                leadTimeDays: 21,
                notes: 'Full-body coverage'
            },
            {
                id: 'PKG-003',
                name: '24-Pack Corrugated Case',
                vendorId: 'VND-009',
                category: 'cases',
                unit: 'ea',
                priceTiers: [
                    { minQty: 500, maxQty: 1999, price: 1.35, setupFee: 0 },
                    { minQty: 2000, maxQty: null, price: 1.20, setupFee: 0 }
                ],
                leadTimeDays: 7,
                notes: ''
            },
            {
                id: 'PKG-004',
                name: 'Plastic Can Carrier (6-pack)',
                vendorId: 'VND-010',
                category: 'carriers',
                unit: 'ea',
                priceTiers: [
                    { minQty: 2000, maxQty: null, price: 0.35, setupFee: 0 }
                ],
                leadTimeDays: 10,
                notes: ''
            },
            {
                id: 'PKG-005',
                name: 'GMA Pallet',
                vendorId: 'VND-011',
                category: 'pallets',
                unit: 'ea',
                priceTiers: [
                    { minQty: 10, maxQty: null, price: 12.50, setupFee: 0 }
                ],
                leadTimeDays: 1,
                notes: 'Standard 48x40'
            }
        ];
    },

    getDefaultServices() {
        return [
            {
                id: 'SVC-001',
                name: 'Can Filling & Seaming',
                providerId: 'VND-012',
                feeType: 'per-unit',
                rate: 0.08,
                minimumCharge: 500,
                leadTimeDays: 3,
                notes: 'Includes nitrogen dosing'
            },
            {
                id: 'SVC-002',
                name: 'Line Setup & Changeover',
                providerId: 'VND-012',
                feeType: 'fixed',
                rate: 1500,
                minimumCharge: 1500,
                leadTimeDays: 1,
                notes: 'Per production run'
            },
            {
                id: 'SVC-003',
                name: 'QA Testing & Inspection',
                providerId: 'VND-012',
                feeType: 'per-batch',
                rate: 750,
                minimumCharge: 750,
                leadTimeDays: 2,
                notes: 'Includes lab analysis'
            },
            {
                id: 'SVC-004',
                name: 'Palletizing & Stretch Wrap',
                providerId: 'VND-012',
                feeType: 'per-pallet',
                rate: 25,
                minimumCharge: 0,
                leadTimeDays: 0,
                notes: ''
            },
            {
                id: 'SVC-005',
                name: 'Cold Storage (30 days)',
                providerId: 'VND-012',
                feeType: 'per-pallet',
                rate: 50,
                minimumCharge: 0,
                leadTimeDays: 0,
                notes: '36-38°F'
            }
        ];
    },

    getDefaultVendors() {
        return [
            { id: 'VND-001', name: 'Municipal Water Supply', contact: '', email: '', phone: '', paymentTerms: 'Net 30', notes: '' },
            { id: 'VND-002', name: 'Cargill Food Ingredients', contact: '', email: '', phone: '', paymentTerms: 'Net 30', notes: '' },
            { id: 'VND-003', name: 'ADM Food Additives', contact: '', email: '', phone: '', paymentTerms: 'Net 30', notes: '' },
            { id: 'VND-004', name: 'Firmenich Flavor Systems', contact: '', email: '', phone: '', paymentTerms: 'Net 30', notes: '' },
            { id: 'VND-005', name: 'Spectrum Chemical', contact: '', email: '', phone: '', paymentTerms: 'Net 30', notes: '' },
            { id: 'VND-006', name: 'Hawkins Inc.', contact: '', email: '', phone: '', paymentTerms: 'Net 30', notes: '' },
            { id: 'VND-007', name: 'Crown Holdings', contact: '', email: '', phone: '', paymentTerms: 'Net 30', notes: '' },
            { id: 'VND-008', name: 'Multi-Color Corporation', contact: '', email: '', phone: '', paymentTerms: 'Net 30', notes: '' },
            { id: 'VND-009', name: 'WestRock', contact: '', email: '', phone: '', paymentTerms: 'Net 30', notes: '' },
            { id: 'VND-010', name: 'Westbridge Packaging', contact: '', email: '', phone: '', paymentTerms: 'Net 30', notes: '' },
            { id: 'VND-011', name: 'CHEP/Local', contact: '', email: '', phone: '', paymentTerms: 'Net 30', notes: '' },
            { id: 'VND-012', name: 'ABC Co-Packer', contact: '', email: '', phone: '', paymentTerms: 'Net 30', notes: '' }
        ];
    }
};

// Initialize on load
if (typeof window !== 'undefined') {
    CoManufacturing.init();
}
