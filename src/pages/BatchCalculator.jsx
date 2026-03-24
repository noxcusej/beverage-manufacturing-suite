import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { getInventory, saveInventory, addInventoryItem, getVendors, getTankConfig, getCurrentBatch, saveBatch, getFormulas, saveFormula as saveFormulaToStore, getClients } from '../data/store';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import * as XLSX from 'xlsx';

const conversions = {
  gal_L: 3.78541, L_gal: 0.264172, gal_ml: 3785.41, ml_gal: 0.000264172,
  gal_oz: 128, oz_gal: 0.0078125, L_ml: 1000, ml_L: 0.001,
  L_oz: 33.814, oz_L: 0.0295703, oz_ml: 29.5703, ml_oz: 0.033814,
  lbs_kg: 0.453592, kg_lbs: 2.20462, lbs_g: 453.592, g_lbs: 0.00220462,
  oz_g: 28.3495, g_oz: 0.035274,
};

function convert(value, from, to) {
  if (from === to) return value;
  const key = `${from}_${to}`;
  if (conversions[key]) return value * conversions[key];
  const rev = `${to}_${from}`;
  if (conversions[rev]) return value / conversions[rev];
  return value;
}

const _weightUnitsSet = new Set(['lbs', 'lb', 'kg', 'g']);
const _volumeUnitsSet = new Set(['gal', 'L', 'ml', 'fl oz']);
function convertWithSG(value, from, to, sg) {
  if (from === to) return value;
  if (_weightUnitsSet.has(from) && _volumeUnitsSet.has(to)) {
    return convert(convert(value, from, 'lbs') / 8.345 * (sg || 1), 'gal', to);
  }
  if (_volumeUnitsSet.has(from) && _weightUnitsSet.has(to)) {
    return convert(convert(value, from, 'gal') * 8.345 / (sg || 1), 'lbs', to);
  }
  return convert(value, from, to);
}

export default function BatchCalculator() {
  const location = useLocation();
  const [inventoryArr, setInventoryArr] = useState(getInventory());
  const inventory = useMemo(() => {
    const obj = {};
    inventoryArr.forEach((item) => { obj[item.id] = item; });
    return obj;
  }, [inventoryArr]);

  const [formulaName, setFormulaName] = useState('');
  const [formulaClient, setFormulaClient] = useState('Uncategorized');
  const [missingPriceIds, setMissingPriceIds] = useState(new Set());
  const [baseYield, setBaseYield] = useState(100);
  const [baseYieldUnit, setBaseYieldUnit] = useState('gal');
  const [batchSize, setBatchSize] = useState(500);
  const [batchSizeUnit, setBatchSizeUnit] = useState('gal');
  const [sizeMode, setSizeMode] = useState('batch'); // 'batch' or 'cases'
  const [targetCases, setTargetCases] = useState(0);
  const [unitSizeVal, setUnitSizeVal] = useState(12);
  const [unitSizeUnit, setUnitSizeUnitState] = useState('oz');
  const [unitsPerCase, setUnitsPerCase] = useState(24);
  const [lossPercent, setLossPercent] = useState(5);
  const [ingredients, setIngredients] = useState([]);
  const [showUnitCalc, setShowUnitCalc] = useState(false);
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [loadSearch, setLoadSearch] = useState('');
  const [showAddIngModal, setShowAddIngModal] = useState(false);
  const [addIngSearch, setAddIngSearch] = useState('');
  const [toast, setToast] = useState(null);
  const [collapsedFolders, setCollapsedFolders] = useState({});
  const [loadHighlight, setLoadHighlight] = useState(0);
  const [addIngHighlight, setAddIngHighlight] = useState(0);
  const [alertsExpanded, setAlertsExpanded] = useState(false);
  const [showOptimizeModal, setShowOptimizeModal] = useState(false);

  const [formulas, setFormulas] = useState(() => getFormulas());
  const [clients, setClients] = useState(() => getClients());

  useEffect(() => {
    const handler = () => {
      setInventoryArr(getInventory());
      setFormulas(getFormulas());
    };
    window.addEventListener('comanufacturing:datachange', handler);
    return () => window.removeEventListener('comanufacturing:datachange', handler);
  }, []);

  // Load saved batch on mount
  useEffect(() => {
    const batch = getCurrentBatch();
    if (batch) {
      if (batch.formulaName) setFormulaName(batch.formulaName);
      if (batch.batchSize) setBatchSize(batch.batchSize);
      if (batch.batchSizeUnit) setBatchSizeUnit(batch.batchSizeUnit);
      if (batch.baseYield) setBaseYield(batch.baseYield);
      if (batch.ingredients) setIngredients(batch.ingredients);
    }
  }, []);

  // Load formula by ?formula=<id> query param (e.g. from ClientProfile click)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const formulaId = params.get('formula');
    if (!formulaId) return;
    const formula = getFormulas().find((f) => f.id === formulaId);
    if (!formula) return;
    setFormulaName(formula.name);
    setFormulaClient(formula.client || 'Uncategorized');
    setMissingPriceIds(new Set());
    const newBaseYield = formula.baseYield || 100;
    const newBaseYieldUnit = formula.baseYieldUnit || 'gal';
    const newBatchSizeUnit = formula.batchSizeUnit || 'gal';
    const newUnitSizeVal = formula.unitSizeVal || 12;
    const newUnitSizeUnit = formula.unitSizeUnit || 'oz';
    const newUnitsPerCase = formula.unitsPerCase || 24;
    const newLossPercent = formula.lossPercent !== undefined ? formula.lossPercent : 0;
    setBaseYield(newBaseYield);
    setBaseYieldUnit(newBaseYieldUnit);
    setBatchSizeUnit(newBatchSizeUnit);
    setUnitSizeVal(newUnitSizeVal);
    setUnitSizeUnitState(newUnitSizeUnit);
    setUnitsPerCase(newUnitsPerCase);
    setLossPercent(newLossPercent);
    if (formula.ingredients) setIngredients(formula.ingredients);
    const savedCases = formula.targetCases || 0;
    if (savedCases > 0) {
      const lossMultiplier = 1 + newLossPercent / 100;
      const units = savedCases * newUnitsPerCase * lossMultiplier;
      let unitOz = newUnitSizeVal;
      if (newUnitSizeUnit === 'ml') unitOz = newUnitSizeVal / 29.5703;
      if (newUnitSizeUnit === 'L') unitOz = newUnitSizeVal * 33.814;
      const totalGal = (units * unitOz) / 128;
      setBatchSize(Math.round((newBatchSizeUnit === 'L' ? totalGal * 3.78541 : totalGal) * 100) / 100);
      setTargetCases(savedCases);
      setSizeMode('cases');
    } else {
      setBatchSize(newBaseYield);
      setTargetCases(0);
      setSizeMode('batch');
    }
  }, [location.search]);

  // Bidirectional: cases → batch size
  function handleCasesChange(cases) {
    setTargetCases(cases);
    setSizeMode('cases');
    // cases → units → oz → gal (with loss adjustment)
    const lossMultiplier = 1 + (lossPercent || 0) / 100;
    const units = cases * unitsPerCase * lossMultiplier;
    let unitOz = unitSizeVal;
    if (unitSizeUnit === 'ml') unitOz = unitSizeVal / 29.5703;
    if (unitSizeUnit === 'L') unitOz = unitSizeVal * 33.814;
    const totalOz = units * unitOz;
    const totalGal = totalOz / 128;
    const newBatch = batchSizeUnit === 'L' ? totalGal * 3.78541 : totalGal;
    setBatchSize(Math.round(newBatch * 100) / 100);
  }

  function handleBatchSizeChange(val) {
    setBatchSize(val);
    setSizeMode('batch');
  }

  const scaleFactor = baseYield > 0 ? batchSize / baseYield : 1;

  // Calculate scaled batch data
  const scaledData = useMemo(() => {
    let totalCost = 0;
    let totalCostWithInventory = 0;
    const rows = ingredients.map((ing) => {
      const item = inventory[ing.inventoryId];
      const scaledRecipe = ing.recipeAmount * scaleFactor;

      // Convert recipe amount to buy unit amount
      // If converting weight → volume or vice versa, use specific gravity
      let buyUnitAmount = scaledRecipe;
      if (ing.recipeUnit !== ing.buyUnit) {
        const weightUnitsSet = new Set(['lbs', 'lb', 'kg', 'g']);
        const volumeUnitsSet = new Set(['gal', 'L', 'ml', 'fl oz']);
        const fromIsWeight = weightUnitsSet.has(ing.recipeUnit);
        const toIsVolume = volumeUnitsSet.has(ing.buyUnit);
        const fromIsVolume = volumeUnitsSet.has(ing.recipeUnit);
        const toIsWeight = weightUnitsSet.has(ing.buyUnit);

        if (fromIsWeight && toIsVolume) {
          // weight → volume: LB/8.345*SG, then convert to target volume unit
          const weightLbs = convert(scaledRecipe, ing.recipeUnit, 'lbs');
          const gallons = weightLbs / 8.345 * (ing.specificGravity || 1);
          buyUnitAmount = convert(gallons, 'gal', ing.buyUnit);
        } else if (fromIsVolume && toIsWeight) {
          // volume → weight: gal*8.345/SG, then convert to target weight unit
          const gallons = convert(scaledRecipe, ing.recipeUnit, 'gal');
          const lbs = gallons * 8.345 / (ing.specificGravity || 1);
          buyUnitAmount = convert(lbs, 'lbs', ing.buyUnit);
        } else {
          buyUnitAmount = convert(scaledRecipe, ing.recipeUnit, ing.buyUnit);
        }
      }

      const orderQty = Math.ceil(buyUnitAmount / (ing.moq || 1)) * (ing.moq || 1);
      const slack = orderQty - buyUnitAmount;
      const lineCost = orderQty * (ing.pricePerBuyUnit || 0);
      totalCost += lineCost;

      // Current inventory in buy units (from manually entered field)
      let onHandBuyUnits = 0;
      const invQty = ing.currentInventory || 0;
      const invUnit = ing.inventoryUnit || ing.buyUnit;
      if (invQty > 0) {
        if (invUnit === ing.buyUnit) {
          onHandBuyUnits = invQty;
        } else {
          onHandBuyUnits = convert(invQty, invUnit, ing.buyUnit);
        }
      }

      // Net amount to purchase (what we actually need to buy)
      const netNeeded = Math.max(0, buyUnitAmount - onHandBuyUnits);
      const netOrderQty = netNeeded > 0 ? Math.ceil(netNeeded / (ing.moq || 1)) * (ing.moq || 1) : 0;
      const netLineCost = netOrderQty * (ing.pricePerBuyUnit || 0);
      totalCostWithInventory += netLineCost;

      // Liquid volume in gallons for volume tracking
      // Always derive from weight using SG: GAL = LB / 8.345 × SG
      // If recipe is already in a volume unit, convert directly to gal
      let liquidGal = 0;
      const weightUnits = ['lbs', 'lb', 'kg', 'g', 'oz'];
      const volumeUnits = ['gal', 'L', 'ml', 'fl oz'];
      if (volumeUnits.includes(ing.recipeUnit)) {
        liquidGal = convert(scaledRecipe, ing.recipeUnit, 'gal');
      } else {
        // Weight-based: convert to lbs first, then apply SG
        const weightLbs = convert(scaledRecipe, ing.recipeUnit, 'lbs');
        liquidGal = weightLbs / 8.345 * (ing.specificGravity || 1);
      }

      return {
        ...ing,
        item,
        scaledRecipe,
        buyUnitAmount,
        orderQty,
        slack,
        lineCost,
        liquidGal,
        onHandBuyUnits,
        netNeeded,
        netOrderQty,
        netLineCost,
        stockOk: onHandBuyUnits >= buyUnitAmount && buyUnitAmount > 0,
        stockPartial: onHandBuyUnits > 0 && onHandBuyUnits < buyUnitAmount,
      };
    });

    return { rows, totalCost, totalCostWithInventory };
  }, [ingredients, inventory, scaleFactor]);

  // Tank allocation
  const tankAllocation = useMemo(() => {
    let batchGal = batchSize;
    if (batchSizeUnit === 'L') batchGal = batchSize / 3.78541;

    const tanks = getTankConfig();
    const sorted = [...tanks].sort((a, b) => b.capacity - a.capacity);
    let remaining = batchGal;
    const alloc = [];

    for (const tank of sorted) {
      if (remaining <= 0) break;
      const allocated = Math.min(remaining, tank.capacity);
      alloc.push({ ...tank, allocated, utilization: ((allocated / tank.capacity) * 100).toFixed(0) });
      remaining -= allocated;
    }

    const totalCap = sorted.reduce((s, t) => s + t.capacity, 0);
    return { alloc, canFit: remaining <= 0, remaining, batchGal, totalCap };
  }, [batchSize, batchSizeUnit]);

  // Unit economics
  const unitEcon = useMemo(() => {
    let batchGal = batchSize;
    if (batchSizeUnit === 'L') batchGal = batchSize / 3.78541;
    const batchOz = batchGal * 128;

    let unitOz = unitSizeVal;
    if (unitSizeUnit === 'ml') unitOz = unitSizeVal / 29.5703;
    if (unitSizeUnit === 'L') unitOz = unitSizeVal * 33.814;

    const totalUnits = unitOz > 0 ? Math.floor(batchOz / unitOz) : 0;
    const totalCases = unitsPerCase > 0 ? Math.ceil(totalUnits / unitsPerCase) : 0;
    const costPerUnit = totalUnits > 0 ? scaledData.totalCost / totalUnits : 0;
    const costPerCase = costPerUnit * unitsPerCase;
    // Net cost (after using inventory on hand)
    const netCostPerUnit = totalUnits > 0 ? scaledData.totalCostWithInventory / totalUnits : 0;
    const netCostPerCase = netCostPerUnit * unitsPerCase;
    const inventorySavings = scaledData.totalCost - scaledData.totalCostWithInventory;
    return { totalUnits, totalCases, costPerUnit, costPerCase, netCostPerUnit, netCostPerCase, inventorySavings };
  }, [batchSize, batchSizeUnit, unitSizeVal, unitSizeUnit, unitsPerCase, scaledData.totalCost, scaledData.totalCostWithInventory]);

  // Optimization: find batch sizes that minimize slack
  const optimizationData = useMemo(() => {
    if (ingredients.length === 0 || baseYield <= 0) return { options: [], ingredientAnalysis: [] };

    // Helper: compute cost/slack for a given batch size
    function computeForBatch(bs) {
      const sf = bs / baseYield;
      let totalCost = 0;
      let totalSlackCost = 0;
      let totalNeeded = 0;
      let totalOrdered = 0;
      const perIng = ingredients.map((ing) => {
        const scaledRecipe = ing.recipeAmount * sf;
        let buyAmt = scaledRecipe;
        if (ing.recipeUnit !== ing.buyUnit) buyAmt = convertWithSG(scaledRecipe, ing.recipeUnit, ing.buyUnit, ing.specificGravity);
        const moq = ing.moq || 1;
        const orderQty = Math.ceil(buyAmt / moq) * moq;
        const slack = orderQty - buyAmt;
        const slackCost = slack * (ing.pricePerBuyUnit || 0);
        const lineCost = orderQty * (ing.pricePerBuyUnit || 0);
        totalCost += lineCost;
        totalSlackCost += slackCost;
        totalNeeded += buyAmt;
        totalOrdered += orderQty;
        return { name: ing.item?.name || inventory[ing.inventoryId]?.name || ing.draftName || 'Unknown', buyAmt, orderQty, slack, slackCost, lineCost, moq, unit: ing.buyUnit, slackPct: orderQty > 0 ? (slack / orderQty) * 100 : 0 };
      });
      // Unit economics for this batch size
      let bsGal = bs;
      if (batchSizeUnit === 'L') bsGal = bs / 3.78541;
      const bsOz = bsGal * 128;
      let uOz = unitSizeVal;
      if (unitSizeUnit === 'ml') uOz = unitSizeVal / 29.5703;
      if (unitSizeUnit === 'L') uOz = unitSizeVal * 33.814;
      const units = uOz > 0 ? Math.floor(bsOz / uOz) : 0;
      const cases = unitsPerCase > 0 ? Math.ceil(units / unitsPerCase) : 0;
      const costPerUnit = units > 0 ? totalCost / units : 0;
      const costPerCase = costPerUnit * unitsPerCase;
      const efficiency = totalOrdered > 0 ? ((totalNeeded / totalOrdered) * 100) : 100;
      return { batchSize: bs, scaleFactor: sf, totalCost, totalSlackCost, efficiency, units, cases, costPerUnit, costPerCase, perIng };
    }

    // Scan a range: 80%-120% of current in fine increments, plus MOQ-aligned batch sizes
    const candidates = new Set();
    const lo = Math.max(baseYield * 0.5, batchSize * 0.8);
    const hi = batchSize * 1.2;
    const step = Math.max(1, Math.round((hi - lo) / 200));
    for (let bs = lo; bs <= hi; bs += step) candidates.add(Math.round(bs));
    candidates.add(batchSize); // always include current

    // Also add MOQ-aligned batch sizes for each ingredient
    ingredients.forEach((ing) => {
      const moq = ing.moq || 1;
      if (moq <= 1 || ing.recipeAmount <= 0) return;
      // Find batch sizes where this ingredient's order lands exactly on MOQ multiple
      let buyPerBase = ing.recipeAmount;
      if (ing.recipeUnit !== ing.buyUnit) buyPerBase = convertWithSG(ing.recipeAmount, ing.recipeUnit, ing.buyUnit, ing.specificGravity);
      const buyPerGal = buyPerBase / baseYield;
      if (buyPerGal <= 0) return;
      for (let m = 1; m <= 50; m++) {
        const perfectBs = (moq * m) / buyPerGal;
        if (perfectBs >= lo && perfectBs <= hi) candidates.add(Math.round(perfectBs));
      }
    });

    const results = [...candidates].map(computeForBatch).sort((a, b) => a.totalSlackCost - b.totalSlackCost);

    // Pick top options: best, current, and a few interesting alternatives
    const current = results.find((r) => r.batchSize === batchSize) || computeForBatch(batchSize);
    const best = results[0];
    // Find options at different batch sizes for variety
    const seen = new Set([best.batchSize, current.batchSize]);
    const others = results.filter((r) => {
      if (seen.has(r.batchSize)) return false;
      // Only include if meaningfully different
      if (Math.abs(r.batchSize - best.batchSize) < step * 3 && r.batchSize !== current.batchSize) return false;
      seen.add(r.batchSize);
      return true;
    }).slice(0, 4);

    const options = [
      { ...best, label: 'Optimal', isBest: true },
      { ...current, label: 'Current', isCurrent: true },
      ...others.map((o) => ({ ...o, label: `${o.batchSize} ${batchSizeUnit}` })),
    ].filter((o, i, arr) => arr.findIndex((x) => x.batchSize === o.batchSize) === i)
      .sort((a, b) => a.batchSize - b.batchSize);

    // Ingredient analysis for current batch
    const ingredientAnalysis = current.perIng;

    return { options, ingredientAnalysis, current, best };
  }, [ingredients, inventory, baseYield, batchSize, batchSizeUnit, unitSizeVal, unitSizeUnit, unitsPerCase]);

  function updateIngredient(index, field, value) {
    setIngredients((prev) => prev.map((ing, i) => {
      if (i !== index) return ing;
      const updated = { ...ing, [field]: value };
      // When buy unit changes, sync inventory unit to match
      if (field === 'buyUnit' && ing.inventoryUnit === ing.buyUnit) {
        updated.inventoryUnit = value;
      }
      return updated;
    }));
  }

  function removeIngredient(index) {
    setIngredients((prev) => prev.filter((_, i) => i !== index));
  }

  function addIngredientFromInventory(item) {
    const tier = item.priceTiers?.[0];
    setIngredients((prev) => [
      ...prev,
      {
        inventoryId: item.id,
        type: item.type || 'liquid',
        recipeAmount: 0,
        recipeUnit: item.unit || 'gal',
        specificGravity: item.specificGravity || 1.0,
        buyUnit: tier?.buyUnit || item.unit || 'gal',
        pricePerBuyUnit: tier?.price || 0,
        moq: tier?.moq || 1,
        currentInventory: item.currentStock || 0,
        inventoryUnit: tier?.buyUnit || item.unit || 'gal',
      },
    ]);
    showToast(`Added "${item.name}"`);
  }

  function openAddIngredientModal() {
    const used = new Set(ingredients.map((i) => i.inventoryId));
    const available = inventoryArr.filter((i) => !used.has(i.id));
    if (available.length === 0) {
      showToast('All inventory items are already in the formula', 'warning');
      return;
    }
    setShowAddIngModal(true);
    setAddIngSearch('');
  }

  function addDraftIngredient() {
    setIngredients((prev) => [
      ...prev,
      {
        inventoryId: '',
        draftName: 'New Ingredient',
        type: 'liquid',
        recipeAmount: 0,
        recipeUnit: 'gal',
        specificGravity: 1.0,
        buyUnit: 'gal',
        pricePerBuyUnit: 0,
        moq: 1,
        currentInventory: 0,
        inventoryUnit: 'gal', // defaults to buy unit
      },
    ]);
  }

  function handleSaveFormula() {
    // Highlight ingredients with missing price
    const missing = new Set(
      ingredients
        .map((ing, i) => (!ing.pricePerBuyUnit || ing.pricePerBuyUnit === 0) ? i : null)
        .filter((i) => i !== null)
    );
    setMissingPriceIds(missing);

    saveFormulaToStore({
      name: formulaName,
      client: formulaClient || 'Uncategorized',
      baseYield, baseYieldUnit,
      batchSize, batchSizeUnit,
      unitSizeVal, unitSizeUnit,
      unitsPerCase, lossPercent,
      targetCases,
      ingredients,
    });

    if (missing.size > 0) {
      showToast(`Saved — ${missing.size} ingredient${missing.size > 1 ? 's' : ''} missing price`, 'warning');
    } else {
      showToast('Formula saved!');
    }
  }

  function handleSaveBatch() {
    saveBatch({
      formulaName, batchSize, batchSizeUnit, baseYield, baseYieldUnit,
      totalUnits: unitEcon.totalUnits,
      ingredients: JSON.parse(JSON.stringify(ingredients)),
    });
    showToast('Batch saved! Context will persist across all calculator pages.');
  }

  function openLoadModal() {
    // Default all folders to collapsed
    const collapsed = {};
    formulas.forEach((f) => { collapsed[f.client || 'Uncategorized'] = true; });
    setCollapsedFolders(collapsed);
    setLoadSearch('');
    setShowLoadModal(true);
  }

  function showToast(message, type = 'success') {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }

  function handleLoadFormula(name) {
    const formula = formulas.find((f) => f.name === name);
    if (!formula) return;
    setFormulaName(formula.name);
    setFormulaClient(formula.client || 'Uncategorized');
    setMissingPriceIds(new Set());
    const newBaseYield = formula.baseYield || 100;
    const newBaseYieldUnit = formula.baseYieldUnit || 'gal';
    const newBatchSizeUnit = formula.batchSizeUnit || 'gal';
    const newUnitSizeVal = formula.unitSizeVal || 12;
    const newUnitSizeUnit = formula.unitSizeUnit || 'oz';
    const newUnitsPerCase = formula.unitsPerCase || 24;
    const newLossPercent = formula.lossPercent !== undefined ? formula.lossPercent : 0;

    setBaseYield(newBaseYield);
    setBaseYieldUnit(newBaseYieldUnit);
    setBatchSizeUnit(newBatchSizeUnit);
    setUnitSizeVal(newUnitSizeVal);
    setUnitSizeUnitState(newUnitSizeUnit);
    setUnitsPerCase(newUnitsPerCase);
    setLossPercent(newLossPercent);
    if (formula.ingredients) setIngredients(formula.ingredients);

    // Recalculate batchSize from saved targetCases if available, else reset to base yield
    const savedCases = formula.targetCases || 0;
    if (savedCases > 0) {
      const lossMultiplier = 1 + newLossPercent / 100;
      const units = savedCases * newUnitsPerCase * lossMultiplier;
      let unitOz = newUnitSizeVal;
      if (newUnitSizeUnit === 'ml') unitOz = newUnitSizeVal / 29.5703;
      if (newUnitSizeUnit === 'L') unitOz = newUnitSizeVal * 33.814;
      const totalOz = units * unitOz;
      const totalGal = totalOz / 128;
      const newBatch = newBatchSizeUnit === 'L' ? totalGal * 3.78541 : totalGal;
      setBatchSize(Math.round(newBatch * 100) / 100);
      setTargetCases(savedCases);
      setSizeMode('cases');
    } else {
      // No cases saved — just load the spec batch size (base yield)
      setBatchSize(newBaseYield);
      setTargetCases(0);
      setSizeMode('batch');
    }

    setShowLoadModal(false);
    setLoadSearch('');
    showToast(`Loaded "${formula.name}" — enter Order Cases to scale`);
  }

  function handleNewFormula() {
    setFormulaName('New Formula');
    setBaseYield(100);
    setBaseYieldUnit('gal');
    setBatchSize(500);
    setBatchSizeUnit('gal');
    setIngredients([]);
    setSizeMode('batch');
    setTargetCases(0);
  }

  useKeyboardShortcuts([
    { key: 'n', ctrl: true, handler: () => handleNewFormula(), allowInInput: true },
    { key: 's', ctrl: true, handler: () => handleSaveFormula(), allowInInput: true },
    { key: 'o', ctrl: true, handler: () => openLoadModal(), allowInInput: true },
    { key: 'e', ctrl: true, handler: () => exportToExcel(), allowInInput: true },
    { key: 'i', ctrl: true, handler: () => openAddIngredientModal(), allowInInput: true },
    { key: 'd', ctrl: true, handler: () => addDraftIngredient(), allowInInput: true },
  ]);

  function exportToExcel() {
    const batchSizeGal = batchSizeUnit === 'L' ? batchSize / 3.78541 : batchSize;
    const wb = XLSX.utils.book_new();

    // SHEET 1: Overview
    const overviewData = [
      ['BEVERAGE BATCH CALCULATOR'],
      ['Formula Export - ' + new Date().toLocaleString()],
      [],
      ['FORMULA DETAILS', '', 'VALUE', 'UNIT'],
      ['Formula Name', formulaName],
      ['Base Yield', '', baseYield, baseYieldUnit],
      ['Target Batch Size', '', batchSize, batchSizeUnit],
      ['Scale Factor', '', scaleFactor.toFixed(4) + 'x'],
      ['Unit Size', '', unitSizeVal, unitSizeUnit],
      ['Units per Case', '', unitsPerCase],
      [],
      ['UNIT ECONOMICS'],
      ['Total Units', '', unitEcon.totalUnits],
      ['Total Cases', '', unitEcon.totalCases],
      ['Total Ingredient Cost', '', '$' + scaledData.totalCost.toFixed(2)],
      ['Net Purchase Cost', '', '$' + scaledData.totalCostWithInventory.toFixed(2)],
      ['Inventory Savings', '', '$' + unitEcon.inventorySavings.toFixed(2)],
      ['Cost per Unit (Full)', '', '$' + unitEcon.costPerUnit.toFixed(4)],
      ['Cost per Unit (Net)', '', '$' + unitEcon.netCostPerUnit.toFixed(4)],
      ['Cost per Case (Full)', '', '$' + unitEcon.costPerCase.toFixed(2)],
      ['Cost per Case (Net)', '', '$' + unitEcon.netCostPerCase.toFixed(2)],
    ];
    const wsOverview = XLSX.utils.aoa_to_sheet(overviewData);
    wsOverview['!cols'] = [{ wch: 25 }, { wch: 20 }, { wch: 15 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, wsOverview, 'Overview');

    // SHEET 2: Base Recipe
    const recipeData = [
      ['BASE RECIPE (per ' + baseYield + ' ' + baseYieldUnit + ')'],
      [],
      ['Item', 'SKU', 'Type', 'Recipe Amt', 'Recipe Unit', 'SG', 'Buy Unit', 'Price/Buy Unit', 'MOQ', 'On Hand', 'Inv Unit'],
      ...ingredients.map((ing) => {
        const item = inventory[ing.inventoryId];
        return [
          item?.name || ing.draftName || 'Unknown',
          item?.sku || '',
          ing.type,
          ing.recipeAmount,
          ing.recipeUnit,
          ing.specificGravity,
          ing.buyUnit,
          ing.pricePerBuyUnit,
          ing.moq,
          ing.currentInventory || 0,
          ing.inventoryUnit || ing.buyUnit,
        ];
      }),
    ];
    const wsRecipe = XLSX.utils.aoa_to_sheet(recipeData);
    wsRecipe['!cols'] = [
      { wch: 25 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 10 },
      { wch: 8 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
    ];
    XLSX.utils.book_append_sheet(wb, wsRecipe, 'Base Recipe');

    // SHEET 3: Scaled Requirements
    const scaledSheetData = [
      ['SCALED BATCH REQUIREMENTS (' + batchSize + ' ' + batchSizeUnit + ')'],
      [],
      ['Item', 'SKU', 'Required', 'Unit', 'On Hand', 'Net to Order', 'Price/Unit', 'MOQ', 'Order Qty', 'Full Cost', 'Net Cost', 'Status'],
      ...scaledData.rows.map((r) => [
        r.item?.name || r.draftName || 'Unknown',
        r.item?.sku || '',
        r.buyUnitAmount.toFixed(2),
        r.buyUnit,
        r.onHandBuyUnits.toFixed(2),
        r.netNeeded.toFixed(2),
        r.pricePerBuyUnit?.toFixed(4) || '0',
        r.moq,
        r.netOrderQty.toFixed(2),
        r.lineCost.toFixed(2),
        r.netLineCost.toFixed(2),
        r.stockOk ? 'In Stock' : r.stockPartial ? 'Partial' : 'Order',
      ]),
      [],
      ['', '', '', '', '', '', '', '', 'TOTALS:', scaledData.totalCost.toFixed(2), scaledData.totalCostWithInventory.toFixed(2)],
      ['', '', '', '', '', '', '', '', 'SAVINGS:', '', unitEcon.inventorySavings.toFixed(2)],
    ];
    const wsScaled = XLSX.utils.aoa_to_sheet(scaledSheetData);
    wsScaled['!cols'] = [
      { wch: 25 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 12 },
      { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
    ];
    XLSX.utils.book_append_sheet(wb, wsScaled, 'Scaled Recipe');

    // SHEET 4: Purchase Order
    const poRows = scaledData.rows.filter((r) => r.netOrderQty > 0);
    const poData = [
      ['PURCHASE ORDER'],
      ['Generated: ' + new Date().toLocaleString()],
      ['Formula: ' + formulaName],
      ['Batch Size: ' + batchSize + ' ' + batchSizeUnit],
      [],
      ['Item', 'SKU', 'Qty to Order', 'Unit', 'Price/Unit', 'Line Total', 'Vendor'],
      ...poRows.map((r) => [
        r.item?.name || r.draftName || 'Unknown',
        r.item?.sku || '',
        r.netOrderQty.toFixed(2),
        r.buyUnit,
        (r.pricePerBuyUnit || 0).toFixed(4),
        r.netLineCost.toFixed(2),
        r.item?.vendor || '',
      ]),
      [],
      ['', '', '', '', 'TOTAL:', scaledData.totalCostWithInventory.toFixed(2)],
    ];
    const wsPO = XLSX.utils.aoa_to_sheet(poData);
    wsPO['!cols'] = [{ wch: 25 }, { wch: 12 }, { wch: 14 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, wsPO, 'Purchase Order');

    XLSX.writeFile(wb, `${formulaName.replace(/\s+/g, '_')}_${batchSize}${batchSizeUnit}_${new Date().toISOString().split('T')[0]}.xlsx`);
  }

  const tableRef = useRef(null);

  function handleCellKeyDown(e, row, col) {
    // Enter on a select: simulate a click to open the dropdown
    if (e.key === 'Enter' && e.target.tagName === 'SELECT') {
      e.preventDefault();
      // showPicker is the modern API to open selects programmatically
      if (e.target.showPicker) {
        try { e.target.showPicker(); } catch (_) { /* some browsers restrict this */ }
      } else {
        // Fallback: simulate mousedown to open
        e.target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      }
      return;
    }

    // Tab moves to next/prev cell
    if (e.key === 'Tab') {
      e.preventDefault();
      const nextCol2 = e.shiftKey ? col - 1 : col + 1;
      let nextRow2 = row;
      let nc = nextCol2;
      if (nc > 9) { nc = 0; nextRow2 = row + 1; }
      if (nc < 0) { nc = 9; nextRow2 = row - 1; }
      const next = tableRef.current?.querySelector(`[data-row="${nextRow2}"][data-col="${nc}"]`);
      if (next) {
        next.focus();
        if (next.tagName === 'INPUT') next.select();
      }
      return;
    }

    // Don't capture arrows when a modal is open
    if (showLoadModal || showAddIngModal) return;

    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const dir = arrows[e.key];
    if (!dir) return;
    e.preventDefault();
    const nextRow = row + dir[0];
    const nextCol = col + dir[1];
    const next = tableRef.current?.querySelector(`[data-row="${nextRow}"][data-col="${nextCol}"]`);
    if (next) {
      next.focus();
      if (next.tagName === 'INPUT') next.select();
    }
  }

  function handleCellFocus(e) {
    if (e.target.tagName === 'INPUT' && (e.target.type === 'number' || e.target.type === 'text')) {
      e.target.select();
    }
  }

  // Stable ref for paste handler so the effect listener always calls latest version
  const pasteHandlerRef = useRef(null);
  pasteHandlerRef.current = useCallback((e) => {
    // Try HTML first (Google Sheets always provides a clean <table>)
    const html = e.clipboardData?.getData('text/html');
    const text = e.clipboardData?.getData('text/plain');

    let pastedRows = [];

    if (html && html.includes('<table')) {
      // Parse HTML table from Google Sheets / Excel
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const trs = doc.querySelectorAll('table tr');
      if (trs.length === 0) return;
      trs.forEach((tr) => {
        const cells = [];
        tr.querySelectorAll('td, th').forEach((td) => cells.push(td.textContent.trim()));
        if (cells.length > 0 && cells.some((c) => c !== '')) pastedRows.push(cells);
      });
    } else if (text) {
      // Fallback: TSV from plain text
      const hasTab = text.includes('\t');
      const lines = text.trim().replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim());
      if (!hasTab && lines.length <= 1) return; // Single value — let default handle
      pastedRows = lines.map((line) => line.split('\t').map((c) => c.trim()));
    }

    if (pastedRows.length === 0) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    // Starting position from focused cell
    const startCol = parseInt(e.target?.dataset?.col ?? '0');
    const startRow = parseInt(e.target?.dataset?.row ?? String(ingredients.length));

    // Column mapping
    const colFields = ['name', 'type', 'recipeAmount', 'recipeUnit', 'specificGravity', 'buyUnit', 'pricePerBuyUnit', 'moq', 'currentInventory', 'inventoryUnit'];
    const validUnits = new Set(['gal', 'L', 'oz', 'ml', 'lbs', 'kg', 'g']);
    const validTypes = new Set(['liquid', 'dry']);

    function matchInventory(name) {
      if (!name) return null;
      const lower = name.toLowerCase().trim();
      return inventoryArr.find((inv) =>
        inv.name.toLowerCase().trim() === lower ||
        (inv.sku && inv.sku.toLowerCase().trim() === lower)
      );
    }

    // Detect header row
    const firstRowLower = pastedRows[0].map((c) => c.toLowerCase());
    const headerKeywords = ['name', 'item', 'ingredient', 'type', 'amount', 'amt', 'recipe', 'unit', 'sg', 'gravity', 'price', 'moq', 'cost', 'buy'];
    const isHeader = firstRowLower.some((c) => headerKeywords.some((kw) => c.includes(kw)));
    const dataRows = isHeader ? pastedRows.slice(1) : pastedRows;

    let colMap = colFields.slice();
    if (isHeader) {
      colMap = firstRowLower.map((h) => {
        if (h.includes('name') || h.includes('item') || h.includes('ingredient')) return 'name';
        if (h.includes('type')) return 'type';
        if ((h.includes('recipe') && h.includes('amt')) || h.includes('amount') || h === 'qty' || h === 'quantity') return 'recipeAmount';
        if ((h.includes('recipe') && h.includes('unit')) || h === 'unit') return 'recipeUnit';
        if (h.includes('sg') || h.includes('gravity') || h.includes('specific')) return 'specificGravity';
        if (h.includes('buy') && h.includes('unit')) return 'buyUnit';
        if (h.includes('price') || h.includes('cost') || h.includes('$/')) return 'pricePerBuyUnit';
        if (h.includes('moq') || h.includes('minimum')) return 'moq';
        if (h.includes('on hand') || h.includes('inventory') || h.includes('stock') || h.includes('on_hand')) return 'currentInventory';
        if (h.includes('inv') && h.includes('unit')) return 'inventoryUnit';
        return null;
      });
    }

    const newIngredients = [...ingredients];
    let added = 0;

    dataRows.forEach((cells, ri) => {
      const targetIdx = startRow + ri;
      const parsed = {};
      cells.forEach((val, ci) => {
        const fieldIdx = isHeader ? ci : startCol + ci;
        const field = isHeader ? colMap[ci] : colFields[fieldIdx];
        if (!field || !val) return;
        if (field === 'name') parsed.name = val;
        else if (field === 'type') parsed.type = validTypes.has(val.toLowerCase()) ? val.toLowerCase() : undefined;
        else if (field === 'recipeAmount') parsed.recipeAmount = parseFloat(val.replace(/[,$]/g, '')) || 0;
        else if (field === 'recipeUnit') { const v = val.toLowerCase(); parsed.recipeUnit = validUnits.has(val) ? val : (validUnits.has(v) ? v : undefined); }
        else if (field === 'specificGravity') parsed.specificGravity = parseFloat(val) || undefined;
        else if (field === 'buyUnit') { const v = val.toLowerCase(); parsed.buyUnit = validUnits.has(val) ? val : (validUnits.has(v) ? v : undefined); }
        else if (field === 'pricePerBuyUnit') parsed.pricePerBuyUnit = parseFloat(val.replace(/[,$]/g, '')) || 0;
        else if (field === 'moq') parsed.moq = parseFloat(val.replace(/[,$]/g, '')) || undefined;
        else if (field === 'currentInventory') parsed.currentInventory = parseFloat(val.replace(/[,$]/g, '')) || 0;
        else if (field === 'inventoryUnit') parsed.inventoryUnit = validUnits.has(val) ? val : undefined;
      });

      const invMatch = matchInventory(parsed.name);

      if (targetIdx < newIngredients.length) {
        const existing = { ...newIngredients[targetIdx] };
        if (parsed.name && !existing.inventoryId && invMatch) {
          const tier = invMatch.priceTiers?.[0];
          existing.inventoryId = invMatch.id;
          existing.type = invMatch.type || existing.type;
          existing.specificGravity = invMatch.specificGravity || existing.specificGravity;
          existing.buyUnit = tier?.buyUnit || invMatch.unit || existing.buyUnit;
          existing.pricePerBuyUnit = tier?.price || existing.pricePerBuyUnit;
          existing.moq = tier?.moq || existing.moq;
          existing.currentInventory = invMatch.currentStock || 0;
          existing.inventoryUnit = tier?.buyUnit || invMatch.unit || existing.inventoryUnit;
        } else if (parsed.name && !invMatch) {
          existing.draftName = parsed.name;
          existing.inventoryId = '';
        }
        if (parsed.type) existing.type = parsed.type;
        if (parsed.recipeAmount !== undefined) existing.recipeAmount = parsed.recipeAmount;
        if (parsed.recipeUnit) existing.recipeUnit = parsed.recipeUnit;
        if (parsed.specificGravity) existing.specificGravity = parsed.specificGravity;
        if (parsed.buyUnit) existing.buyUnit = parsed.buyUnit;
        if (parsed.pricePerBuyUnit !== undefined) existing.pricePerBuyUnit = parsed.pricePerBuyUnit;
        if (parsed.moq) existing.moq = parsed.moq;
        if (parsed.currentInventory !== undefined) existing.currentInventory = parsed.currentInventory;
        if (parsed.inventoryUnit) existing.inventoryUnit = parsed.inventoryUnit;
        newIngredients[targetIdx] = existing;
      } else {
        const tier = invMatch?.priceTiers?.[0];
        newIngredients.push({
          inventoryId: invMatch?.id || '',
          draftName: invMatch ? undefined : (parsed.name || 'Pasted Ingredient'),
          type: parsed.type || invMatch?.type || 'liquid',
          recipeAmount: parsed.recipeAmount || 0,
          recipeUnit: parsed.recipeUnit || invMatch?.unit || 'gal',
          specificGravity: parsed.specificGravity || invMatch?.specificGravity || 1.0,
          buyUnit: parsed.buyUnit || tier?.buyUnit || invMatch?.unit || 'gal',
          pricePerBuyUnit: parsed.pricePerBuyUnit ?? tier?.price ?? 0,
          moq: parsed.moq || tier?.moq || 1,
          currentInventory: parsed.currentInventory ?? invMatch?.currentStock ?? 0,
          inventoryUnit: parsed.inventoryUnit || tier?.buyUnit || invMatch?.unit || 'gal',
        });
        added++;
      }
    });

    setIngredients(newIngredients);
    showToast(`Pasted ${dataRows.length} row${dataRows.length !== 1 ? 's' : ''}${added > 0 ? ` · ${added} new` : ''}`);
  }, [ingredients, inventoryArr]);

  // Register paste listener in capture phase on the entire container, not just the table
  useEffect(() => {
    function onPaste(e) {
      // Only handle if focus is inside the ingredients table
      if (tableRef.current && tableRef.current.contains(e.target)) {
        pasteHandlerRef.current?.(e);
      }
    }
    document.addEventListener('paste', onPaste, true);
    return () => document.removeEventListener('paste', onPaste, true);
  }, []);

  function exportCSV() {
    const header = ['Item', 'SKU', 'Required', 'Buy Unit Amt', 'Price/Unit', 'MOQ', 'Order Qty', 'Line Cost'];
    const rows = scaledData.rows.map((r) => [
      r.item?.name || r.draftName || 'Unknown',
      r.item?.sku || '',
      r.scaledRecipe.toFixed(2) + ' ' + r.recipeUnit,
      r.buyUnitAmount.toFixed(2) + ' ' + r.buyUnit,
      '$' + (r.pricePerBuyUnit || 0).toFixed(4),
      r.moq,
      r.orderQty.toFixed(2),
      '$' + r.lineCost.toFixed(2),
    ]);
    const csv = [header, ...rows].map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `batch_${formulaName.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  }

  return (
    <div className="container">
      {/* Page Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <div style={{ display: 'inline-block', padding: '3px 10px', background: 'var(--brand-100)', color: 'var(--brand)', borderRadius: 4, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 }}>
            Pro Edition
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', margin: 0, lineHeight: 1.2 }}>Formula Calculator</h1>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 4 }}>Configure batch scaling and ingredient costs for production runs.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn" onClick={handleNewFormula}>New Formula</button>
          <button className="btn" onClick={() => setShowOptimizeModal(true)} style={{ background: '#fef3c7', borderColor: '#fbbf24', color: '#92400e' }}>⚡ Optimize</button>
          <button className="btn" onClick={exportToExcel}>Export Excel</button>
          <button className="btn btn-primary" onClick={handleSaveFormula}>Save Recipe</button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="cost-summary" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 24 }}>
        <div className="cost-card">
          <div className="cost-card-label">Scale Factor</div>
          <div className="cost-card-value">{scaleFactor.toFixed(2)}x</div>
          <div className="cost-card-subtitle">{baseYield} {baseYieldUnit} &rarr; {batchSize} {batchSizeUnit}</div>
        </div>
        <div className="cost-card">
          <div className="cost-card-label">Total Ingredient Cost</div>
          <div className="cost-card-value">${scaledData.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div className="cost-card-subtitle">${unitEcon.costPerUnit.toFixed(3)} / unit</div>
        </div>
        <div className="cost-card hero">
          <div className="cost-card-label">Net Purchase Cost</div>
          <div className="cost-card-value">${scaledData.totalCostWithInventory.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div className="cost-card-subtitle">${unitEcon.netCostPerUnit.toFixed(3)} / unit</div>
        </div>
        <div className="cost-card" style={{ background: unitEcon.inventorySavings > 0 ? '#d1fae5' : undefined }}>
          <div className="cost-card-label">Inventory Savings</div>
          <div className="cost-card-value" style={{ color: unitEcon.inventorySavings > 0 ? '#065f46' : undefined }}>${unitEcon.inventorySavings.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div className="cost-card-subtitle">{unitEcon.totalCases.toLocaleString()} cases &bull; {unitEcon.totalUnits.toLocaleString()} units</div>
        </div>
      </div>

      <div className="batch-grid" style={{ alignItems: 'start' }}>
        {/* Main Column */}
        <div>
          {/* Formula Architecture */}
          <div className="section" style={{ marginBottom: 20 }}>
            <div className="section-header">
              <div className="section-title">Formula Architecture</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn btn-small" onClick={() => openLoadModal()}>💥 Load Formula</button>
                <button className="btn btn-small" onClick={handleSaveBatch}>Push to Production</button>
              </div>
            </div>
            <div className="section-body">
              <div className="form-grid-3">
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Formula Name</label>
                  <input type="text" value={formulaName} onChange={(e) => setFormulaName(e.target.value)} />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Client</label>
                  <select value={formulaClient} onChange={(e) => setFormulaClient(e.target.value)}>
                    <option value="Uncategorized">Uncategorized</option>
                    {clients.map((c) => (
                      <option key={c.id || c.name} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Base Yield</label>
                  <div className="input-with-unit">
                    <input type="number" value={baseYield} onChange={(e) => setBaseYield(parseFloat(e.target.value) || 0)} />
                    <select value={baseYieldUnit} onChange={(e) => setBaseYieldUnit(e.target.value)}>
                      <option value="gal">gal</option>
                      <option value="L">L</option>
                    </select>
                  </div>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Target Batch Size {sizeMode === 'cases' && <span style={{ fontSize: 10, color: '#9ca3af', fontWeight: 400 }}>(from cases)</span>}</label>
                  <div className="input-with-unit">
                    <input
                      type="number"
                      value={batchSize}
                      onChange={(e) => handleBatchSizeChange(parseFloat(e.target.value) || 0)}
                      style={sizeMode === 'cases' ? { background: '#f3f4f6', color: '#9ca3af' } : {}}
                    />
                    <select value={batchSizeUnit} onChange={(e) => setBatchSizeUnit(e.target.value)}>
                      <option value="gal">gal</option>
                      <option value="L">L</option>
                    </select>
                  </div>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Unit Size</label>
                  <div className="input-with-unit">
                    <input type="number" value={unitSizeVal} onChange={(e) => setUnitSizeVal(parseFloat(e.target.value) || 0)} />
                    <select value={unitSizeUnit} onChange={(e) => setUnitSizeUnitState(e.target.value)}>
                      <option value="oz">oz</option>
                      <option value="ml">mL</option>
                      <option value="L">L</option>
                    </select>
                  </div>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Units per Case</label>
                  <input type="number" value={unitsPerCase} onChange={(e) => setUnitsPerCase(parseInt(e.target.value) || 1)} />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Loss Adj %</label>
                  <input type="number" value={lossPercent} min={0} max={50} step={0.5} onChange={(e) => setLossPercent(parseFloat(e.target.value) || 0)} />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Order Cases {sizeMode === 'cases' && <span style={{ fontSize: 10, color: '#7062E0', fontWeight: 600 }}>DRIVING</span>}</label>
                  <input
                    type="number"
                    value={sizeMode === 'cases' ? targetCases : unitEcon.totalCases}
                    onChange={(e) => handleCasesChange(parseInt(e.target.value) || 0)}
                    onFocus={handleCellFocus}
                    style={sizeMode === 'cases' ? { borderColor: '#7062E0', boxShadow: '0 0 0 2px rgba(112,98,224,0.15)' } : {}}
                  />
                </div>
              </div>
              {/* Calculated output row */}
              <div style={{ display: 'flex', gap: 16, marginTop: 12, padding: '10px 14px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb' }}>
                <div style={{ fontSize: 12, color: '#6b7280' }}>Total Units: <span style={{ fontWeight: 700, color: '#1f2937' }}>{unitEcon.totalUnits.toLocaleString()}</span></div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>Total Cases: <span style={{ fontWeight: 700, color: '#1f2937' }}>{unitEcon.totalCases.toLocaleString()}</span></div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>Scale: <span style={{ fontWeight: 700, color: '#1f2937' }}>{scaleFactor.toFixed(2)}x</span></div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>Cost/Case: <span style={{ fontWeight: 700, color: '#10b981' }}>${unitEcon.netCostPerCase.toFixed(2)}</span></div>
              </div>
            </div>
          </div>

          {/* Ingredients Table */}
          <div className="section" style={{ marginBottom: 20 }}>
            <div className="section-header">
              <div className="section-title">Ingredients</div>
            </div>
            <div style={{ overflowX: 'auto', width: '100%' }}>
              <table ref={tableRef}>
                <thead>
                  <tr>
                    <th style={{ maxWidth: 180, position: 'sticky', left: 0, zIndex: 2, background: 'var(--surface-alt)' }}>Ingredient</th>
                    <th className="col-optional">Type</th>
                    <th>Recipe Amt</th>
                    <th>Recipe Unit</th>
                    <th className="col-optional">SG</th>
                    <th>Buy Unit</th>
                    <th>Price/Buy Unit</th>
                    <th className="col-optional">MOQ</th>
                    <th className="col-optional">On Hand</th>
                    <th className="col-optional">Inv. Unit</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {ingredients.map((ing, idx) => {
                    const item = inventory[ing.inventoryId];
                    return (
                      <tr key={idx}>
                        <td style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface)', boxShadow: '2px 0 4px rgba(0,0,0,0.06)' }}>
                          {ing.inventoryId && !ing.inventoryId.startsWith('DRAFT-') ? (
                            <select
                              data-row={idx} data-col={0}
                              value={ing.inventoryId}
                              onKeyDown={(e) => handleCellKeyDown(e, idx, 0)}
                              onChange={(e) => {
                                const newItem = inventory[e.target.value];
                                if (newItem) {
                                  const tier = newItem.priceTiers?.[0];
                                  updateIngredient(idx, 'inventoryId', e.target.value);
                                  setIngredients((prev) =>
                                    prev.map((i, j) =>
                                      j === idx
                                        ? {
                                            ...i,
                                            inventoryId: e.target.value,
                                            type: newItem.type || i.type,
                                            specificGravity: newItem.specificGravity || i.specificGravity,
                                            buyUnit: tier?.buyUnit || newItem.unit || i.buyUnit,
                                            pricePerBuyUnit: tier?.price || i.pricePerBuyUnit,
                                            moq: tier?.moq || i.moq,
                                            currentInventory: newItem.currentStock || 0,
                                            inventoryUnit: tier?.buyUnit || newItem.unit || i.inventoryUnit,
                                          }
                                        : i
                                    )
                                  );
                                }
                              }}
                              style={{ width: 160 }}
                            >
                              <option value="">-- Select --</option>
                              {inventoryArr.map((inv) => (
                                <option key={inv.id} value={inv.id}>{inv.name}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              data-row={idx} data-col={0}
                              type="text"
                              value={ing.draftName || ''}
                              onChange={(e) => updateIngredient(idx, 'draftName', e.target.value)}
                              onFocus={handleCellFocus}
                              onKeyDown={(e) => handleCellKeyDown(e, idx, 0)}
                              placeholder="Draft ingredient"
                              style={{ width: 160 }}
                            />
                          )}
                        </td>
                        <td className="col-optional">
                          <select data-row={idx} data-col={1} value={ing.type} onChange={(e) => updateIngredient(idx, 'type', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, idx, 1)}>
                            <option value="liquid">Liquid</option>
                            <option value="dry">Dry</option>
                          </select>
                        </td>
                        <td>
                          <input
                            data-row={idx} data-col={2}
                            type="number"
                            value={ing.recipeAmount}
                            onChange={(e) => updateIngredient(idx, 'recipeAmount', parseFloat(e.target.value) || 0)}
                            onFocus={handleCellFocus}
                            onKeyDown={(e) => handleCellKeyDown(e, idx, 2)}
                            style={{ width: 80 }}
                          />
                        </td>
                        <td>
                          <select data-row={idx} data-col={3} value={ing.recipeUnit} onChange={(e) => updateIngredient(idx, 'recipeUnit', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, idx, 3)}>
                            <option value="gal">gal</option><option value="L">L</option><option value="oz">oz</option>
                            <option value="ml">mL</option><option value="lbs">lbs</option><option value="kg">kg</option><option value="g">g</option>
                          </select>
                        </td>
                        <td className="col-optional">
                          <input
                            data-row={idx} data-col={4}
                            type="number"
                            value={ing.specificGravity}
                            onChange={(e) => updateIngredient(idx, 'specificGravity', parseFloat(e.target.value) || 1.0)}
                            onFocus={handleCellFocus}
                            onKeyDown={(e) => handleCellKeyDown(e, idx, 4)}
                            step="0.01"
                            style={{ width: 60 }}
                          />
                        </td>
                        <td>
                          <select data-row={idx} data-col={5} value={ing.buyUnit} onChange={(e) => updateIngredient(idx, 'buyUnit', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, idx, 5)}>
                            <option value="gal">gal</option><option value="L">L</option><option value="lbs">lbs</option>
                            <option value="kg">kg</option><option value="oz">oz</option><option value="g">g</option>
                          </select>
                        </td>
                        <td>
                          <input
                            data-row={idx} data-col={6}
                            type="number"
                            value={ing.pricePerBuyUnit}
                            onChange={(e) => { const val = parseFloat(e.target.value) || 0; updateIngredient(idx, 'pricePerBuyUnit', val); if (val > 0) setMissingPriceIds((prev) => { const next = new Set(prev); next.delete(idx); return next; }); }}
                            onFocus={handleCellFocus}
                            onKeyDown={(e) => handleCellKeyDown(e, idx, 6)}
                            step="0.0001"
                            style={{ width: 90, background: missingPriceIds.has(idx) ? '#fef9c3' : undefined, borderColor: missingPriceIds.has(idx) ? '#eab308' : undefined }}
                          />
                        </td>
                        <td className="col-optional">
                          <input
                            data-row={idx} data-col={7}
                            type="number"
                            value={ing.moq}
                            onChange={(e) => updateIngredient(idx, 'moq', parseFloat(e.target.value) || 1)}
                            onFocus={handleCellFocus}
                            onKeyDown={(e) => handleCellKeyDown(e, idx, 7)}
                            style={{ width: 70 }}
                          />
                        </td>
                        <td className="col-optional">
                          <input
                            data-row={idx} data-col={8}
                            type="number"
                            value={ing.currentInventory || 0}
                            onChange={(e) => updateIngredient(idx, 'currentInventory', parseFloat(e.target.value) || 0)}
                            onFocus={handleCellFocus}
                            onKeyDown={(e) => handleCellKeyDown(e, idx, 8)}
                            style={{ width: 80 }}
                          />
                        </td>
                        <td className="col-optional">
                          <select data-row={idx} data-col={9} value={ing.inventoryUnit || 'gal'} onChange={(e) => updateIngredient(idx, 'inventoryUnit', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, idx, 9)}>
                            <option value="gal">gal</option><option value="L">L</option><option value="lbs">lbs</option>
                            <option value="kg">kg</option><option value="oz">oz</option><option value="g">g</option>
                          </select>
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {scaleFactor > 0 && ing.recipeAmount > 0 ? (() => {
                            const scaledRecipe = ing.recipeAmount * scaleFactor;
                            let buyNeeded = scaledRecipe;
                            if (ing.recipeUnit !== ing.buyUnit) buyNeeded = convertWithSG(scaledRecipe, ing.recipeUnit, ing.buyUnit, ing.specificGravity);
                            const invQty = ing.currentInventory || 0;
                            const invUnit = ing.inventoryUnit || ing.buyUnit;
                            let onHand = invUnit === ing.buyUnit ? invQty : convert(invQty, invUnit, ing.buyUnit);
                            const pct = buyNeeded > 0 ? Math.min((onHand / buyNeeded) * 100, 100) : 100;
                            const net = Math.max(0, buyNeeded - onHand);
                            const color = pct >= 100 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
                            return (
                              <div>
                                <div style={{ height: 4, background: '#e5e7eb', borderRadius: 2, overflow: 'hidden', marginBottom: 3 }}>
                                  <div style={{ height: '100%', background: color, width: `${pct}%`, transition: 'width 0.3s' }} />
                                </div>
                                {net > 0 ? (
                                  <span style={{ color, fontWeight: 600 }}>Need {net.toFixed(1)} {ing.buyUnit}</span>
                                ) : (
                                  <span style={{ color: '#10b981', fontWeight: 600 }}>Covered ✓</span>
                                )}
                              </div>
                            );
                          })() : '\u2014'}
                        </td>
                        <td>
                          <button className="btn btn-small btn-danger" onClick={() => removeIngredient(idx)}>x</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={12} style={{ padding: 12, background: '#f9fafb', borderTop: '2px solid #e5e7eb' }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-primary" onClick={openAddIngredientModal} style={{ flex: 1, justifyContent: 'center' }}>
                          + Add from Inventory
                        </button>
                        <button className="btn" onClick={addDraftIngredient} style={{ flex: 1, justifyContent: 'center' }}>
                          + Add Draft (Quick Entry)
                        </button>
                      </div>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Scaled Batch Requirements */}
          <div className="section">
            <div className="section-header">
              <div className="section-title">Scaled Batch Requirements & Purchase Order</div>
              <button className="btn btn-small" onClick={exportCSV}>Export CSV</button>
            </div>
            <div>
              <table>
                <thead>
                  <tr>
                    <th>Inventory Item</th>
                    <th>SKU</th>
                    <th>Required</th>
                    <th>On Hand</th>
                    <th>Net to Order</th>
                    <th>Price/Unit</th>
                    <th>MOQ</th>
                    <th>Order Qty</th>
                    <th>Full Cost</th>
                    <th>Net Cost</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {scaledData.rows.map((row, idx) => (
                    <tr key={idx}>
                      <td style={{ fontWeight: 600 }}>{row.item?.name || row.draftName || 'Unknown'}</td>
                      <td style={{ fontSize: 12, color: '#6b7280' }}>{row.item?.sku || '\u2014'}</td>
                      <td>{row.buyUnitAmount.toFixed(2)} {row.buyUnit}</td>
                      <td style={{ fontWeight: 600, color: row.stockOk ? '#10b981' : row.stockPartial ? '#f59e0b' : '#6b7280' }}>
                        {row.onHandBuyUnits > 0 ? `${row.onHandBuyUnits.toFixed(2)} ${row.buyUnit}` : '\u2014'}
                      </td>
                      <td style={{ fontWeight: 600, color: row.netNeeded > 0 ? '#ef4444' : '#10b981' }}>
                        {row.netNeeded > 0 ? `${row.netNeeded.toFixed(2)} ${row.buyUnit}` : 'Covered ✓'}
                      </td>
                      <td>${(row.pricePerBuyUnit || 0).toFixed(4)}</td>
                      <td>{row.moq}</td>
                      <td style={{ fontWeight: 600 }}>{row.netOrderQty > 0 ? `${row.netOrderQty.toFixed(2)} ${row.buyUnit}` : '\u2014'}</td>
                      <td style={{ color: '#6b7280', fontSize: 12 }}>${row.lineCost.toFixed(2)}</td>
                      <td style={{ fontWeight: 700 }}>${row.netLineCost.toFixed(2)}</td>
                      <td>
                        <span className={`badge ${row.stockOk ? 'badge-success' : row.stockPartial ? 'badge-warning' : 'badge-danger'}`}>
                          {row.stockOk ? 'In Stock' : row.stockPartial ? 'Partial' : 'Order'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={8} style={{ textAlign: 'right', fontWeight: 600 }}>Totals:</td>
                    <td style={{ fontSize: 13, color: '#6b7280' }}>${scaledData.totalCost.toFixed(2)}</td>
                    <td style={{ fontWeight: 700, fontSize: 15 }}>${scaledData.totalCostWithInventory.toFixed(2)}</td>
                    <td></td>
                  </tr>
                  {unitEcon.inventorySavings > 0 && (
                    <tr>
                      <td colSpan={8} style={{ textAlign: 'right', fontWeight: 600, color: '#10b981' }}>Inventory Savings:</td>
                      <td colSpan={2} style={{ fontWeight: 700, color: '#10b981', fontSize: 14 }}>−${unitEcon.inventorySavings.toFixed(2)}</td>
                      <td></td>
                    </tr>
                  )}
                </tfoot>
              </table>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div>
          {/* Calculated Batch ROI */}
          <div className="projection-card" style={{ marginBottom: 20 }}>
            <h3>Calculated Batch ROI</h3>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Net Purchase Cost</div>
            <div className="projection-total">${scaledData.totalCostWithInventory.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            {unitEcon.inventorySavings > 0 && (
              <div style={{ fontSize: 12, color: '#6ee7b7', marginBottom: 8 }}>
                Saving ${unitEcon.inventorySavings.toFixed(2)} from inventory on hand
              </div>
            )}
            <div style={{ display: 'flex', gap: 24, marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase' }}>Net Cost/Unit</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>${unitEcon.netCostPerUnit.toFixed(3)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase' }}>Yield</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{unitEcon.totalUnits.toLocaleString()}</div>
              </div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', marginBottom: 4 }}>Capacity Utilization</div>
              <div style={{ background: 'rgba(255,255,255,0.15)', borderRadius: 4, height: 8 }}>
                <div style={{ background: '#A78BFA', borderRadius: 4, height: 8, width: `${Math.min(scaleFactor * 10, 100)}%`, transition: 'width 0.3s' }}></div>
              </div>
              <div style={{ fontSize: 12, marginTop: 4, textAlign: 'right' }}>{Math.min(scaleFactor * 10, 100).toFixed(0)}%</div>
            </div>
            <div className="cost-breakdown" style={{ marginTop: 12 }}>
              {scaledData.rows.slice(0, 5).map((row, idx) => (
                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', fontSize: 13, borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                    {row.item?.name || row.draftName || 'Unknown'}
                    {row.stockOk && <span style={{ color: '#6ee7b7', marginLeft: 4, fontSize: 10 }}>✓</span>}
                  </span>
                  <span style={{ fontWeight: 600 }}>
                    {row.netLineCost < row.lineCost ? (
                      <>
                        <span style={{ textDecoration: 'line-through', color: 'rgba(255,255,255,0.3)', marginRight: 6, fontSize: 11 }}>${row.lineCost.toFixed(2)}</span>
                        ${row.netLineCost.toFixed(2)}
                      </>
                    ) : `$${row.lineCost.toFixed(2)}`}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Production Constants */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border-light)', borderRadius: 'var(--radius)', overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,0.04)', marginBottom: 20 }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface-alt)' }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Production Constants</div>
            </div>
            <div style={{ padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #F1F5F9' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Total Units</span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{unitEcon.totalUnits.toLocaleString()}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #F1F5F9' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Total Cases</span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{unitEcon.totalCases.toLocaleString()}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #F1F5F9' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Cost per Case (Full)</span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>${unitEcon.costPerCase.toFixed(2)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #F1F5F9' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Cost per Case (Net)</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#10b981' }}>${unitEcon.netCostPerCase.toFixed(2)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Scale Factor</span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{scaleFactor.toFixed(2)}x</span>
              </div>
            </div>
          </div>

          {/* Inventory Alerts */}
          {(() => {
            const needsOrder = scaledData.rows.filter((r) => !r.stockOk);
            const partialCount = needsOrder.filter((r) => r.stockPartial).length;
            const orderCount = needsOrder.length - partialCount;
            return (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border-light)', borderRadius: 'var(--radius)', overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
                <div
                  onClick={() => setAlertsExpanded((prev) => !prev)}
                  style={{ padding: '10px 14px', borderBottom: alertsExpanded ? '1px solid var(--border)' : 'none', background: 'var(--surface-alt)', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', userSelect: 'none' }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700 }}>Inventory Alerts</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {needsOrder.length === 0 ? (
                      <span style={{ fontSize: 11, color: '#10b981', fontWeight: 600 }}>✓ All covered</span>
                    ) : (
                      <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 600 }}>
                        {needsOrder.length} alert{needsOrder.length !== 1 ? 's' : ''}
                        {partialCount > 0 && ` · ${partialCount} partial`}
                      </span>
                    )}
                    <span style={{ fontSize: 10, transition: 'transform 0.2s', display: 'inline-block', transform: alertsExpanded ? 'rotate(0deg)' : 'rotate(-90deg)', color: '#9ca3af' }}>▼</span>
                  </div>
                </div>
                {alertsExpanded && (
                  <div style={{ padding: 14 }}>
                    {needsOrder.length === 0 ? (
                      <div style={{ fontSize: 13, color: '#10b981', padding: '8px 0' }}>✓ All ingredients covered by current inventory</div>
                    ) : (
                      needsOrder.map((r, idx) => (
                        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #F1F5F9', fontSize: 13 }}>
                          <span style={{ color: r.stockPartial ? '#F59E0B' : '#EF4444', fontSize: 16 }}>{r.stockPartial ? '⚠' : '✕'}</span>
                          <div>
                            <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.item?.name || r.draftName}</div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                              Need {r.buyUnitAmount.toFixed(2)} {r.buyUnit} — have {r.onHandBuyUnits.toFixed(2)} — order {r.netNeeded.toFixed(2)} {r.buyUnit}
                            </div>
                            <div style={{ fontSize: 11, color: '#ef4444', fontWeight: 600 }}>Est. ${r.netLineCost.toFixed(2)}</div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Insight Cards */}
      <div className="insight-cards" style={{ marginTop: 24 }}>
        <div className="insight-card">
          <h4>Efficiency Alert</h4>
          <p>
            {scaleFactor > 5
              ? `Scale factor of ${scaleFactor.toFixed(1)}x may exceed optimal capacity. Consider splitting into multiple batches.`
              : `Batch is within efficient range at ${scaleFactor.toFixed(1)}x scale.`}
          </p>
        </div>
        <div className="insight-card">
          <h4>Cost Optimization</h4>
          <p>
            {scaledData.totalCost > 0
              ? `Total ingredient cost $${scaledData.totalCost.toFixed(2)}. Unit cost $${unitEcon.costPerUnit.toFixed(3)} across ${unitEcon.totalUnits.toLocaleString()} units.`
              : 'Add ingredients to see cost analysis.'}
          </p>
        </div>
        <div className="insight-card">
          <h4>Stock Status</h4>
          <p>
            {scaledData.rows.filter((r) => !r.stockOk).length === 0
              ? 'All ingredients are in stock for this batch size.'
              : `${scaledData.rows.filter((r) => !r.stockOk).length} ingredient(s) need ordering before production.`}
          </p>
        </div>
      </div>

      {/* Load Formula Modal */}
      {showLoadModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => { setShowLoadModal(false); setLoadSearch(''); }}>
          <div style={{ background: 'white', borderRadius: 12, width: 480, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #e5e7eb' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>💥 Load Formula</h3>
                <button onClick={() => { setShowLoadModal(false); setLoadSearch(''); }} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af', padding: '4px 8px' }}>&times;</button>
              </div>
              <input
                type="text"
                placeholder="Search formulas..."
                value={loadSearch}
                onChange={(e) => { setLoadSearch(e.target.value); setLoadHighlight(0); }}
                onKeyDown={(e) => {
                  // Build flat list of visible formulas for keyboard nav
                  const grouped = {};
                  formulas
                    .filter((f) => !loadSearch || f.name.toLowerCase().includes(loadSearch.toLowerCase()) || (f.client || '').toLowerCase().includes(loadSearch.toLowerCase()))
                    .forEach((f) => { const c = f.client || 'Uncategorized'; if (!grouped[c]) grouped[c] = []; grouped[c].push(f); });
                  const visible = [];
                  Object.entries(grouped).forEach(([client, fms]) => {
                    if (!collapsedFolders[client] || loadSearch) fms.forEach((f) => visible.push(f));
                  });
                  if (e.key === 'ArrowDown') { e.preventDefault(); setLoadHighlight((h) => Math.min(h + 1, visible.length - 1)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setLoadHighlight((h) => Math.max(h - 1, 0)); }
                  else if (e.key === 'Enter' && visible[loadHighlight]) { e.preventDefault(); handleLoadFormula(visible[loadHighlight].name); }
                  else if (e.key === 'Escape') { setShowLoadModal(false); setLoadSearch(''); }
                }}
                autoFocus
                style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14 }}
              />
            </div>
            <div style={{ overflowY: 'auto', padding: '8px 12px', flex: 1 }}>
              {(() => {
                const grouped = {};
                formulas
                  .filter((f) => !loadSearch || f.name.toLowerCase().includes(loadSearch.toLowerCase()) || (f.client || '').toLowerCase().includes(loadSearch.toLowerCase()))
                  .forEach((f) => {
                    const client = f.client || 'Uncategorized';
                    if (!grouped[client]) grouped[client] = [];
                    grouped[client].push(f);
                  });
                const entries = Object.entries(grouped);
                if (entries.length === 0) {
                  return <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>No formulas found</div>;
                }
                let flatIdx = 0;
                return entries.map(([client, fms]) => {
                  const isCollapsed = collapsedFolders[client] && !loadSearch;
                  const startIdx = flatIdx;
                  if (!isCollapsed) flatIdx += fms.length;
                  return (
                    <div key={client} style={{ marginBottom: 4 }}>
                      <div
                        onClick={() => setCollapsedFolders((prev) => ({ ...prev, [client]: !prev[client] }))}
                        style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, padding: '8px 12px 4px', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none', borderRadius: 6, transition: 'background 0.15s' }}
                        onMouseEnter={(e) => e.currentTarget.style.background = '#f3f4f6'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <span style={{ fontSize: 10, transition: 'transform 0.2s', display: 'inline-block', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                        <span>📁</span> {client}
                        <span style={{ fontSize: 10, color: '#9ca3af', fontWeight: 500 }}>({fms.length})</span>
                      </div>
                      {!isCollapsed && fms.map((f, fi) => {
                        const thisIdx = startIdx + fi;
                        const isHighlighted = thisIdx === loadHighlight;
                        return (
                          <div
                            key={f.name}
                            onClick={() => handleLoadFormula(f.name)}
                            onMouseEnter={() => setLoadHighlight(thisIdx)}
                            style={{ padding: '10px 12px 10px 32px', borderRadius: 8, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', transition: 'background 0.15s', background: isHighlighted ? '#f0f4ff' : 'transparent' }}
                          >
                            <div>
                              <div style={{ fontSize: 14, fontWeight: 600, color: '#1f2937' }}>{f.name}</div>
                              <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                                {f.ingredients?.length || 0} ingredients
                                {f.baseYield ? ` · ${f.baseYield} ${f.baseYieldUnit || 'gal'} base` : ''}
                                {f.updatedAt ? ` · ${new Date(f.updatedAt).toLocaleDateString()}` : ''}
                              </div>
                            </div>
                            <span style={{ fontSize: 18, color: isHighlighted ? '#7062E0' : '#d1d5db' }}>&rsaquo;</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                });
              })()}
            </div>
            <div style={{ padding: '12px 24px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#9ca3af' }}>{formulas.length} formula{formulas.length !== 1 ? 's' : ''} saved</span>
              <button className="btn btn-small" onClick={() => { setShowLoadModal(false); setLoadSearch(''); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Optimization Analytics Modal */}
      {showOptimizeModal && optimizationData.options.length > 0 && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setShowOptimizeModal(false)}>
          <div style={{ background: 'white', borderRadius: 12, width: 820, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #e5e7eb' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>⚡ Run Size Optimization</h3>
                  <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Minimize ingredient slack by adjusting batch size to align with MOQ boundaries</p>
                </div>
                <button onClick={() => setShowOptimizeModal(false)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af', padding: '4px 8px' }}>&times;</button>
              </div>
              {/* Savings callout */}
              {optimizationData.best && optimizationData.current && optimizationData.best.batchSize !== batchSize && (
                <div style={{ marginTop: 12, padding: '10px 14px', background: '#d1fae5', border: '1px solid #86efac', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#065f46' }}>
                      Save ${(optimizationData.current.totalSlackCost - optimizationData.best.totalSlackCost).toFixed(2)} in slack waste
                    </div>
                    <div style={{ fontSize: 12, color: '#047857' }}>
                      Adjust from {batchSize} → {optimizationData.best.batchSize} {batchSizeUnit} ({optimizationData.best.efficiency.toFixed(1)}% efficiency)
                    </div>
                  </div>
                  <button
                    className="btn btn-small btn-primary"
                    onClick={() => { setBatchSize(optimizationData.best.batchSize); setShowOptimizeModal(false); showToast(`Batch size set to ${optimizationData.best.batchSize} ${batchSizeUnit}`); }}
                  >Apply Optimal</button>
                </div>
              )}
            </div>

            <div style={{ overflowY: 'auto', flex: 1, padding: '16px 24px' }}>
              {/* Options comparison table */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: '#374151' }}>Batch Size Options</div>
                <table style={{ width: '100%', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600, fontSize: 11, color: '#6b7280', textTransform: 'uppercase' }}>Batch Size</th>
                      <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 600, fontSize: 11, color: '#6b7280', textTransform: 'uppercase' }}>Scale</th>
                      <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 600, fontSize: 11, color: '#6b7280', textTransform: 'uppercase' }}>Cases</th>
                      <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 600, fontSize: 11, color: '#6b7280', textTransform: 'uppercase' }}>Total Cost</th>
                      <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 600, fontSize: 11, color: '#6b7280', textTransform: 'uppercase' }}>Slack Cost</th>
                      <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 600, fontSize: 11, color: '#6b7280', textTransform: 'uppercase' }}>Efficiency</th>
                      <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 600, fontSize: 11, color: '#6b7280', textTransform: 'uppercase' }}>Cost/Case</th>
                      <th style={{ padding: '8px 10px' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {optimizationData.options.map((opt) => (
                      <tr key={opt.batchSize} style={{ borderBottom: '1px solid #f1f5f9', background: opt.isBest ? '#f0fdf4' : opt.isCurrent ? '#eff6ff' : 'transparent' }}>
                        <td style={{ padding: '10px', fontWeight: 600 }}>
                          {opt.batchSize} {batchSizeUnit}
                          {opt.isBest && <span style={{ marginLeft: 6, fontSize: 10, background: '#10b981', color: 'white', padding: '1px 6px', borderRadius: 4, fontWeight: 700 }}>BEST</span>}
                          {opt.isCurrent && <span style={{ marginLeft: 6, fontSize: 10, background: '#3b82f6', color: 'white', padding: '1px 6px', borderRadius: 4, fontWeight: 700 }}>CURRENT</span>}
                        </td>
                        <td style={{ textAlign: 'right', padding: '10px' }}>{opt.scaleFactor.toFixed(2)}x</td>
                        <td style={{ textAlign: 'right', padding: '10px' }}>{opt.cases.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', padding: '10px', fontWeight: 600 }}>${opt.totalCost.toFixed(2)}</td>
                        <td style={{ textAlign: 'right', padding: '10px', color: opt.totalSlackCost < (optimizationData.current?.totalSlackCost || 0) ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                          ${opt.totalSlackCost.toFixed(2)}
                        </td>
                        <td style={{ textAlign: 'right', padding: '10px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                            <div style={{ width: 50, height: 6, background: '#e5e7eb', borderRadius: 3, overflow: 'hidden' }}>
                              <div style={{ height: '100%', background: opt.efficiency > 95 ? '#10b981' : opt.efficiency > 85 ? '#f59e0b' : '#ef4444', width: `${opt.efficiency}%` }} />
                            </div>
                            <span style={{ fontSize: 12 }}>{opt.efficiency.toFixed(1)}%</span>
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', padding: '10px', fontWeight: 600 }}>${opt.costPerCase.toFixed(2)}</td>
                        <td style={{ padding: '10px' }}>
                          {!opt.isCurrent && (
                            <button
                              className="btn btn-small"
                              onClick={() => { setBatchSize(opt.batchSize); setShowOptimizeModal(false); showToast(`Batch size set to ${opt.batchSize} ${batchSizeUnit}`); }}
                              style={{ fontSize: 11, padding: '3px 8px' }}
                            >Apply</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Per-ingredient analysis */}
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: '#374151' }}>Ingredient Slack Analysis (Current: {batchSize} {batchSizeUnit})</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {optimizationData.ingredientAnalysis.map((ing, idx) => (
                    <div key={idx} style={{ padding: '12px 14px', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <div>
                          <span style={{ fontWeight: 600, fontSize: 14 }}>{ing.name}</span>
                          <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 8 }}>MOQ: {ing.moq} {ing.unit}</span>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <span style={{ fontWeight: 700, color: ing.slackCost > 0 ? '#ef4444' : '#10b981', fontSize: 14 }}>
                            {ing.slackCost > 0 ? `$${ing.slackCost.toFixed(2)} waste` : 'No waste'}
                          </span>
                        </div>
                      </div>
                      {/* Visual bars */}
                      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 6 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6b7280', marginBottom: 3 }}>
                            <span>Needed: {ing.buyAmt.toFixed(2)} {ing.unit}</span>
                            <span>Ordered: {ing.orderQty.toFixed(2)} {ing.unit}</span>
                          </div>
                          <div style={{ height: 20, background: '#e5e7eb', borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
                            {/* Needed portion */}
                            <div style={{
                              position: 'absolute', left: 0, top: 0, bottom: 0,
                              width: `${ing.orderQty > 0 ? (ing.buyAmt / ing.orderQty) * 100 : 100}%`,
                              background: '#7062E0', borderRadius: '4px 0 0 4px',
                              transition: 'width 0.3s',
                            }} />
                            {/* Slack portion */}
                            {ing.slack > 0 && (
                              <div style={{
                                position: 'absolute', top: 0, bottom: 0,
                                left: `${(ing.buyAmt / ing.orderQty) * 100}%`,
                                right: 0,
                                background: 'repeating-linear-gradient(45deg, #fca5a5, #fca5a5 4px, #fecaca 4px, #fecaca 8px)',
                                borderRadius: '0 4px 4px 0',
                              }} />
                            )}
                            {/* MOQ tick marks */}
                            {ing.orderQty > 0 && Array.from({ length: Math.floor(ing.orderQty / ing.moq) }, (_, i) => {
                              const pos = ((i + 1) * ing.moq / ing.orderQty) * 100;
                              return pos < 100 ? (
                                <div key={i} style={{ position: 'absolute', left: `${pos}%`, top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.5)' }} />
                              ) : null;
                            })}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#6b7280' }}>
                        <span>Slack: <strong style={{ color: ing.slack > 0 ? '#ef4444' : '#10b981' }}>{ing.slack.toFixed(2)} {ing.unit} ({ing.slackPct.toFixed(1)}%)</strong></span>
                        <span>Line cost: <strong>${ing.lineCost.toFixed(2)}</strong></span>
                        <span>Efficiency: <strong style={{ color: (100 - ing.slackPct) > 90 ? '#10b981' : '#f59e0b' }}>{(100 - ing.slackPct).toFixed(1)}%</strong></span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Summary stats */}
              {optimizationData.current && (
                <div style={{ marginTop: 20, padding: '14px 16px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb', display: 'flex', gap: 24 }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3 }}>Total Slack Cost</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#ef4444' }}>${optimizationData.current.totalSlackCost.toFixed(2)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3 }}>Buying Efficiency</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: optimizationData.current.efficiency > 90 ? '#10b981' : '#f59e0b' }}>{optimizationData.current.efficiency.toFixed(1)}%</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3 }}>Potential Savings</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#10b981' }}>
                      ${(optimizationData.current.totalSlackCost - (optimizationData.best?.totalSlackCost || 0)).toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3 }}>Worst Offender</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#1f2937' }}>
                      {optimizationData.ingredientAnalysis.length > 0
                        ? optimizationData.ingredientAnalysis.sort((a, b) => b.slackCost - a.slackCost)[0]?.name
                        : '—'}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: '12px 24px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-small" onClick={() => setShowOptimizeModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Add Ingredient Modal */}
      {showAddIngModal && (() => {
        const used = new Set(ingredients.map((i) => i.inventoryId));
        const available = inventoryArr.filter((i) => !used.has(i.id));
        const filtered = addIngSearch
          ? available.filter((i) => i.name.toLowerCase().includes(addIngSearch.toLowerCase()) || (i.sku || '').toLowerCase().includes(addIngSearch.toLowerCase()))
          : available;
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => { setShowAddIngModal(false); setAddIngSearch(''); }}>
            <div style={{ background: 'white', borderRadius: 12, width: 480, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={(e) => e.stopPropagation()}>
              <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #e5e7eb' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Add from Inventory</h3>
                  <button onClick={() => { setShowAddIngModal(false); setAddIngSearch(''); }} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af', padding: '4px 8px' }}>&times;</button>
                </div>
                <input
                  type="text"
                  placeholder="Search ingredients..."
                  value={addIngSearch}
                  onChange={(e) => { setAddIngSearch(e.target.value); setAddIngHighlight(0); }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setAddIngHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setAddIngHighlight((h) => Math.max(h - 1, 0)); }
                    else if (e.key === 'Enter' && filtered[addIngHighlight]) { e.preventDefault(); addIngredientFromInventory(filtered[addIngHighlight]); }
                    else if (e.key === 'Escape') { setShowAddIngModal(false); setAddIngSearch(''); }
                  }}
                  autoFocus
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14 }}
                />
              </div>
              <div style={{ overflowY: 'auto', padding: '8px 12px', flex: 1 }}>
                {filtered.length === 0 ? (
                  <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>
                    {available.length === 0 ? 'All inventory items are in the formula' : 'No matches found'}
                  </div>
                ) : (
                  filtered.map((item, fi) => {
                    const tier = item.priceTiers?.[0];
                    const isHighlighted = fi === addIngHighlight;
                    return (
                      <div
                        key={item.id}
                        onClick={() => addIngredientFromInventory(item)}
                        onMouseEnter={() => setAddIngHighlight(fi)}
                        style={{ padding: '10px 12px', borderRadius: 8, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', transition: 'background 0.15s', background: isHighlighted ? '#f0f4ff' : 'transparent' }}
                      >
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: '#1f2937' }}>{item.name}</div>
                          <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                            {item.sku || 'No SKU'} · {item.type || 'liquid'} · {item.currentStock || 0} {item.unit} on hand
                            {tier ? ` · $${tier.price}/${tier.buyUnit}` : ''}
                          </div>
                        </div>
                        <span style={{ fontSize: 13, color: isHighlighted ? '#7062E0' : '#d1d5db', fontWeight: 600 }}>+ Add</span>
                      </div>
                    );
                  })
                )}
              </div>
              <div style={{ padding: '12px 24px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#9ca3af' }}>{available.length} available · {used.size} in formula</span>
                <button className="btn btn-small" onClick={() => { setShowAddIngModal(false); setAddIngSearch(''); }}>Cancel</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Toast Notification */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 1100,
          padding: '12px 20px', borderRadius: 10,
          background: toast.type === 'warning' ? '#fef3c7' : toast.type === 'error' ? '#fee2e2' : '#d1fae5',
          color: toast.type === 'warning' ? '#92400e' : toast.type === 'error' ? '#991b1b' : '#065f46',
          fontWeight: 600, fontSize: 14,
          boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
          animation: 'fadeInUp 0.3s ease',
        }}>
          {toast.type === 'warning' ? '⚠️ ' : toast.type === 'error' ? '❌ ' : '✅ '}{toast.message}
        </div>
      )}
    </div>
  );
}
