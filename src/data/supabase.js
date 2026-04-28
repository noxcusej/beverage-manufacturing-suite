import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

// ── Generic app_data CRUD ──

export async function loadAppData(key) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('app_data')
      .select('data')
      .eq('key', key)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // row not found
      console.error(`[Supabase] load ${key} error:`, error.message);
      return null;
    }
    return data?.data ?? null;
  } catch (err) {
    console.error(`[Supabase] load ${key} exception:`, err);
    return null;
  }
}

export async function saveAppData(key, value) {
  if (!supabase) return false;
  try {
    const { error } = await supabase
      .from('app_data')
      .upsert(
        { key, data: value, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );

    if (error) {
      console.error(`[Supabase] save ${key} error:`, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[Supabase] save ${key} exception:`, err);
    return false;
  }
}

// ── Formula sync helpers (uses dedicated formulas table) ──

export async function loadFormulasFromSupabase() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('formulas')
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('[Supabase] loadFormulas error:', error.message);
      return null;
    }

    return data.map(row => ({
      ...row.data,
      id: row.id,
      name: row.name,
      client: row.client,
      versions: row.versions || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  } catch (err) {
    console.error('[Supabase] loadFormulas exception:', err);
    return null;
  }
}

export async function saveFormulaToSupabase(formula) {
  if (!supabase) return false;
  try {
    const { versions, id, name, client, ...rest } = formula;

    const row = {
      id: id,
      name: name,
      client: client || 'Uncategorized',
      data: {
        ...rest,
        baseYield: formula.baseYield,
        baseYieldUnit: formula.baseYieldUnit,
        batchSize: formula.batchSize,
        batchSizeUnit: formula.batchSizeUnit,
        unitSizeVal: formula.unitSizeVal,
        unitSizeUnit: formula.unitSizeUnit,
        unitsPerCase: formula.unitsPerCase,
        lossPercent: formula.lossPercent,
        targetCases: formula.targetCases,
        ingredients: formula.ingredients,
        packaging: formula.packaging,
        services: formula.services,
      },
      versions: versions || [],
    };

    const { error } = await supabase
      .from('formulas')
      .upsert(row, { onConflict: 'id' });

    if (error) {
      console.error('[Supabase] saveFormula error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Supabase] saveFormula exception:', err);
    return false;
  }
}

export async function syncAllFormulasToSupabase(formulas) {
  if (!supabase) return false;
  try {
    const rows = formulas.map(f => {
      const { versions, id, name, client, ...rest } = f;
      return {
        id: id,
        name: name,
        client: client || 'Uncategorized',
        data: rest,
        versions: versions || [],
      };
    });

    const { error } = await supabase
      .from('formulas')
      .upsert(rows, { onConflict: 'id' });

    if (error) {
      console.error('[Supabase] syncAll error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Supabase] syncAll exception:', err);
    return false;
  }
}

export async function deleteFormulaFromSupabase(formulaId) {
  if (!supabase) return false;
  try {
    const { error } = await supabase
      .from('formulas')
      .delete()
      .eq('id', formulaId);

    if (error) {
      console.error('[Supabase] deleteFormula error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Supabase] deleteFormula exception:', err);
    return false;
  }
}
