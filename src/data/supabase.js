import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

// ── Formula sync helpers ──

/**
 * Load all formulas from Supabase.
 * Returns the array of formula objects (with versions) or null on error.
 */
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

    // Reconstruct formula objects from DB rows
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

/**
 * Upsert a single formula to Supabase.
 */
export async function saveFormulaToSupabase(formula) {
  if (!supabase) return false;
  try {
    // Separate versions from the data blob
    const { versions, id, name, client, createdAt, updatedAt, ...rest } = formula;

    const row = {
      id: id,
      name: name,
      client: client || 'Uncategorized',
      data: { ...rest, batchSize: formula.batchSize, batchSizeUnit: formula.batchSizeUnit, baseYield: formula.baseYield, ingredients: formula.ingredients, packaging: formula.packaging, services: formula.services },
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

/**
 * Sync all formulas from localStorage to Supabase (bulk upsert).
 */
export async function syncAllFormulasToSupabase(formulas) {
  if (!supabase) return false;
  try {
    const rows = formulas.map(f => {
      const { versions, id, name, client, createdAt, updatedAt, ...rest } = f;
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

/**
 * Delete a formula from Supabase by ID.
 */
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
