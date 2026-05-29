import { useEffect, useMemo, useState } from 'react';
import {
  CARRIER_TYPES,
  createEmptyPlan,
  createStraightGroup,
  createVarietyGroup,
  computePlanDerived,
  describeGroup,
} from './packagingPlan.js';

// Configure how the run's produced cans get packed: any number of straight or
// variety pack groups, each pulling cans from the per-SKU produced totals.
// The modal works on a draft copy of the plan so closing without Apply leaves
// the run's committed plan untouched.

const PACK_SIZE_OPTIONS = [4, 6, 8, 12, 15, 18, 24];

function round1(n) {
  return Math.round((n || 0) * 10) / 10;
}

// Component is mounted/unmounted by the parent (no internal `open` flag), so
// draft state is naturally fresh per open — no setState-in-effect needed to
// reset it.
export default function PackagingPlanModal({
  onClose,
  onApply,
  initialPlan,
  flavorRows,
  unitsPerCase,
  casesPerPallet,
  defaultPackSize = 4,
}) {
  const [draft, setDraft] = useState(() => initialPlan || createEmptyPlan());

  // Esc to close
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const flavorById = useMemo(() => {
    const map = {};
    (flavorRows || []).forEach((f) => { map[f.id] = f; });
    return map;
  }, [flavorRows]);

  const derived = useMemo(
    () => computePlanDerived(draft, flavorRows, { unitsPerCase, casesPerPallet }),
    [draft, flavorRows, unitsPerCase, casesPerPallet],
  );

  function updateGroup(id, patch) {
    setDraft((prev) => ({
      ...prev,
      groups: prev.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    }));
  }

  function updateMixCans(id, skuId, cans) {
    setDraft((prev) => ({
      ...prev,
      groups: prev.groups.map((g) => {
        if (g.id !== id) return g;
        const safe = Math.max(0, Math.floor(cans || 0));
        const has = (g.mix || []).some((m) => m.skuId === skuId);
        const mix = has
          ? g.mix.map((m) => (m.skuId === skuId ? { ...m, cans: safe } : m))
          : [...(g.mix || []), { skuId, cans: safe }];
        return { ...g, mix };
      }),
    }));
  }

  function removeGroup(id) {
    setDraft((prev) => ({ ...prev, groups: prev.groups.filter((g) => g.id !== id) }));
  }

  function setAllocationMode(mode) {
    setDraft((prev) => ({ ...prev, allocationMode: mode }));
  }

  // Sets a single group's % directly. NO auto-rebalance — other groups
  // stay exactly where they are. The user explicitly clicks Auto-balance
  // (even-split) or Cap-to-fit (single-group cap with rebalance) when
  // they want redistribution. If totals drift away from 100%, validation
  // surfaces it as an error.
  function setGroupPercent(id, pctValue) {
    const next = round1(Math.max(0, Math.min(100, Number(pctValue) || 0)));
    setDraft((prev) => ({
      ...prev,
      groups: (prev.groups || []).map((g) =>
        g.id === id ? { ...g, allocationPercent: next } : g
      ),
    }));
  }


  // Cap a single group at its max; do NOT rebalance the other groups (their
  // values stay exactly where the user put them). After capping, the
  // group is no longer over-allocated; the run total may drop below 100%
  // and the validation banner says so. User then manually redistributes,
  // or clicks Auto-balance.
  function capGroupToFit(group) {
    if (!group) return;
    if (draft.allocationMode === 'percent') {
      const cappedPct = round1(Math.max(0, Math.min(100, Number(group.maxPercentAllowed) || 0)));
      setDraft((prev) => ({
        ...prev,
        groups: prev.groups.map((g) => (g.id === group.id ? { ...g, allocationPercent: cappedPct } : g)),
      }));
      return;
    }
    const unitsPerCaseSafe = unitsPerCase || 24;
    const maxCases = Math.floor((group.maxCansAllowed || 0) / unitsPerCaseSafe);
    setDraft((prev) => ({
      ...prev,
      groups: prev.groups.map((g) => (g.id === group.id ? { ...g, casesCount: maxCases } : g)),
    }));
  }

  // Iteratively cap the worst over-allocator until none remain or no
  // progress can be made. Useful when two groups mutually contend over the
  // same SKU and capping one alone still leaves over-allocation behind —
  // particularly the variety + straight case the user flagged.
  function autoFitAll() {
    setDraft((prev) => {
      let current = { ...prev, groups: (prev.groups || []).map((g) => ({ ...g })) };
      const opts = { unitsPerCase, casesPerPallet };
      let prevWorstId = null;
      let prevWorst = -1;
      for (let iter = 0; iter < 20; iter += 1) {
        const der = computePlanDerived(current, flavorRows, opts);
        if ((der.overAllocatedGroups || []).length === 0) break;
        const worst = der.overAllocatedGroups.slice().sort((a, b) => b.overByCans - a.overByCans)[0];
        // Stop only when the SAME group is still worst with the SAME overByCans
        // (genuine no-progress). A different group with an identical overByCans
        // value is still real work to do.
        if (worst.groupId === prevWorstId && worst.overByCans === prevWorst) break;
        prevWorstId = worst.groupId;
        prevWorst = worst.overByCans;
        if (der.allocationMode === 'percent') {
          const newPct = round1(worst.maxPercent);
          // Cap only — do NOT rebalance others (matches the "no auto
          // rebalance unless I click" rule). Total may drop below 100; user
          // explicitly redistributes via Auto-balance.
          current = {
            ...current,
            groups: current.groups.map((g) =>
              g.id === worst.groupId ? { ...g, allocationPercent: newPct } : g),
          };
        } else {
          const unitsPerCaseSafe = unitsPerCase || 24;
          const maxCases = Math.floor((worst.maxCans || 0) / unitsPerCaseSafe);
          current = {
            ...current,
            groups: current.groups.map((g) =>
              g.id === worst.groupId ? { ...g, casesCount: maxCases } : g),
          };
        }
      }
      return current;
    });
  }

  // Set all groups' allocations evenly across groups of their type, where
  // each category gets a share proportional to the number of groups it has —
  // good "fresh slate" button for the user.
  function distributeEvenly() {
    setDraft((prev) => {
      const groups = prev.groups || [];
      if (groups.length === 0) return prev;
      const per = round1(100 / groups.length);
      // Fix rounding drift on the last item so the sum is exactly 100.
      const allocs = groups.map(() => per);
      const drift = round1(100 - per * groups.length);
      allocs[allocs.length - 1] = round1(per + drift);
      return {
        ...prev,
        groups: groups.map((g, i) => ({ ...g, allocationPercent: allocs[i] })),
      };
    });
  }

  function addStraight() {
    const firstSku = flavorRows?.[0]?.id || '';
    setDraft((prev) => ({
      ...prev,
      groups: [
        ...prev.groups,
        createStraightGroup({ skuId: firstSku, packSize: defaultPackSize, carrierType: 'paktech' }),
      ],
    }));
  }

  function addVariety() {
    const skuIds = (flavorRows || []).map((f) => f.id);
    setDraft((prev) => ({
      ...prev,
      groups: [
        ...prev.groups,
        createVarietyGroup({ packSize: 12, carrierType: 'carton', skuIds }),
      ],
    }));
  }

  function handleApply() {
    if (!derived.valid) return;
    onApply(draft);
    onClose();
  }

  // ── Render ──

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed', top: '4%', left: '50%', transform: 'translateX(-50%)',
          width: 940, maxWidth: '95vw', maxHeight: '92vh', overflowY: 'auto',
          background: 'white', borderRadius: 12,
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)',
          zIndex: 9001, padding: 24,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>Configure packaging</h2>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Split the run's produced cans into straight and variety pack groups.
            </div>
          </div>
          <button className="btn btn-small" onClick={onClose}>Close</button>
        </div>

        {/* Per-SKU run totals + remaining */}
        <SectionLabel>Run totals</SectionLabel>
        <div style={{ overflowX: 'auto', marginBottom: 18 }}>
          <table style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={th}>SKU</th>
                <th style={thRight}>Produced</th>
                <th style={thRight}>Allocated</th>
                <th style={thRight}>Remaining</th>
              </tr>
            </thead>
            <tbody>
              {(flavorRows || []).map((f) => {
                const allocated = derived.cansAllocatedPerSku[f.id] || 0;
                const remaining = derived.cansRemainingPerSku[f.id] ?? (f.cans - allocated);
                const over = remaining < 0;
                return (
                  <tr key={f.id}>
                    <td style={td}>{f.name || '(unnamed)'}</td>
                    <td style={tdRight}>{fmt(f.cans)}</td>
                    <td style={tdRight}>{fmt(allocated)}</td>
                    <td style={{ ...tdRight, color: over ? '#b91c1c' : (remaining === 0 ? '#15803d' : 'var(--text-primary)'), fontWeight: 600 }}>
                      {fmt(remaining)}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td style={{ ...td, fontWeight: 700 }}>Total</td>
                <td style={{ ...tdRight, fontWeight: 700 }}>{fmt(derived.totalCansProduced)}</td>
                <td style={{ ...tdRight, fontWeight: 700 }}>{fmt(derived.totalCansAllocated)}</td>
                <td style={{ ...tdRight, fontWeight: 700, color: derived.totalCansRemaining < 0 ? '#b91c1c' : (derived.totalCansRemaining === 0 ? '#15803d' : 'var(--text-primary)') }}>
                  {fmt(derived.totalCansRemaining)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Allocation mode + summary */}
        <SectionLabel>Allocation</SectionLabel>
        <div style={{
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 14,
          padding: '10px 14px', marginBottom: 14,
          background: 'var(--surface)', border: '1px solid var(--border-light)', borderRadius: 8,
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={derived.allocationMode === 'percent'}
              onChange={(e) => setAllocationMode(e.target.checked ? 'percent' : 'manual')}
            />
            <span style={{ fontWeight: 600 }}>Allocate by percentage</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {derived.allocationMode === 'percent'
                ? '(each group is independent — totals only change when you click Auto-balance or Cap to fit)'
                : '(cases drive packs; toggle on to use %)'}
            </span>
          </label>
          {derived.allocationMode === 'percent' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginLeft: 'auto', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ color: '#15803d', fontWeight: 700 }}>STRAIGHT</span>
                <span style={{ fontWeight: 700 }}>{derived.straightPercent}%</span>
                <span style={{ color: 'var(--text-muted)' }}>·</span>
                <span style={{ color: '#be185d', fontWeight: 700 }}>VARIETY</span>
                <span style={{ fontWeight: 700 }}>{derived.varietyPercent}%</span>
                <span style={{ color: 'var(--text-muted)' }}>·</span>
                <span style={{
                  fontWeight: 700,
                  color: Math.abs(derived.totalPercent - 100) < 0.05
                    ? '#15803d'
                    : (derived.totalPercent > 100 ? '#b91c1c' : '#a16207'),
                }}>
                  {derived.totalPercent}% total
                  {Math.abs(derived.totalPercent - 100) < 0.05 ? ' ✓' : ''}
                </span>
              </div>
              <button className="btn btn-small" onClick={distributeEvenly} title="Split 100% evenly across all groups">
                Auto-balance
              </button>
            </div>
          )}
        </div>

        {/* Group list */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <SectionLabel inline>Pack groups</SectionLabel>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-small" onClick={addStraight}>+ Straight pack</button>
            <button className="btn btn-small" onClick={addVariety}>+ Variety pack</button>
          </div>
        </div>

        {derived.groups.length === 0 && (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No pack groups yet. Add a straight pack (single SKU) or variety pack (SKU mix per pack).
          </div>
        )}

        <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
          {derived.groups.map((g, idx) => (
            <GroupCard
              key={g.id}
              group={g}
              index={idx}
              flavorRows={flavorRows}
              flavorById={flavorById}
              onChange={(patch) => updateGroup(g.id, patch)}
              onMixChange={(skuId, cans) => updateMixCans(g.id, skuId, cans)}
              onPercentChange={(pct) => setGroupPercent(g.id, pct)}
              onRemove={() => removeGroup(g.id)}
              unitsPerCase={unitsPerCase}
              allocationMode={derived.allocationMode}
            />
          ))}
        </div>

        {/* Validation banner — per-group rows are actionable so the user can
            click "Cap to fit" and resolve the over-allocation in one move. */}
        {(derived.errors.length > 0 || derived.overAllocatedGroups.length > 0) && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#b91c1c', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Fix before applying
              </div>
              {derived.overAllocatedGroups.length > 1 && (
                <button
                  className="btn btn-small"
                  onClick={autoFitAll}
                  style={{ fontSize: 11, background: '#b91c1c', color: 'white', borderColor: '#b91c1c' }}
                  title="Iteratively cap the worst over-allocators until none remain"
                >
                  Fit all
                </button>
              )}
            </div>
            {derived.overAllocatedGroups.length > 0 && (
              <div style={{ marginBottom: derived.errors.length > 0 ? 8 : 0 }}>
                {derived.overAllocatedGroups.map((oa) => {
                  const group = derived.groups.find((g) => g.id === oa.groupId);
                  return (
                    <div key={oa.groupId} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '6px 8px', marginBottom: 4,
                      background: 'white', border: '1px solid #fecaca', borderRadius: 6,
                      fontSize: 13, color: '#7f1d1d',
                    }}>
                      <div>
                        <strong>{oa.label}</strong> over by <strong>{fmt(oa.overByCans)}</strong> cans
                        {' · '}
                        {derived.allocationMode === 'percent'
                          ? <>requested <strong>{oa.currentPercent}%</strong>, max <strong>{oa.maxPercent}%</strong></>
                          : <>requested <strong>{fmt(oa.currentCans)}</strong> cans, max <strong>{fmt(oa.maxCans)}</strong></>}
                      </div>
                      <button
                        className="btn btn-small"
                        onClick={() => capGroupToFit(group)}
                        style={{ background: '#b91c1c', color: 'white', borderColor: '#b91c1c' }}
                      >
                        Cap to fit
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {derived.errors.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, color: '#7f1d1d', fontSize: 13 }}>
                {derived.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
          </div>
        )}

        {/* Footer summary + actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-light)', paddingTop: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {derived.active
              ? `${fmt(derived.totalPacks)} packs · ${fmt(derived.totalCases)} cases · ${fmt(derived.totalPallets)} pallets · ${fmt(derived.totalVarietyPacks)} variety`
              : 'No packs configured — run will use the legacy single pack-size math.'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-small" onClick={onClose}>Cancel</button>
            <button
              className="btn btn-primary"
              onClick={handleApply}
              disabled={!derived.valid}
              style={!derived.valid ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
              title={!derived.valid ? 'Resolve validation errors first' : 'Apply plan'}
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──

function GroupCard({ group, index, flavorRows, flavorById, onChange, onMixChange, onPercentChange, onRemove, unitsPerCase, allocationMode }) {
  const consumed = group.cansConsumed || 0;
  const packs = group.packsCount || 0;
  const cases = unitsPerCase > 0 ? Math.ceil(consumed / unitsPerCase) : 0;
  const title = describeGroup(group, flavorById) || `Group ${index + 1}`;
  const isPct = allocationMode === 'percent';
  return (
    <div style={{ border: '1px solid var(--border-light)', borderRadius: 8, padding: 14, background: 'var(--surface)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...chip, background: group.type === 'variety' ? '#fce7f3' : '#dcfce7', color: group.type === 'variety' ? '#be185d' : '#15803d' }}>
            {group.type === 'variety' ? 'Variety' : 'Straight'}
          </span>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
        </div>
        <button className="btn btn-small" onClick={onRemove} style={{ color: '#b91c1c' }}>Delete</button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        {/* Label */}
        <Field label="Label">
          <input
            type="text"
            value={group.label || ''}
            placeholder="optional"
            onChange={(e) => onChange({ label: e.target.value })}
            style={{ width: 180 }}
          />
        </Field>

        {/* Pack size */}
        <Field label="Pack size">
          <select
            value={group.packSize}
            onChange={(e) => onChange({ packSize: parseInt(e.target.value, 10) || 1 })}
            style={{ fontSize: 12 }}
          >
            {PACK_SIZE_OPTIONS.map((s) => <option key={s} value={s}>{s}-pk</option>)}
          </select>
        </Field>

        {/* Ruling input — cases (manual) or % (percent). The % input is
            UNCONTROLLED (defaultValue + onBlur) so typing doesn't trigger a
            rebalance on every keystroke; the `key` resets the input when
            the prop changes from outside (auto-balance, cap-to-fit, other
            group's rebalance). */}
        {isPct ? (
          <Field label="% of total cans">
            <input
              key={`pct-${group.id}-${group.allocationPercent ?? 0}`}
              type="number" min={0} max={100} step={0.1}
              defaultValue={group.allocationPercent ?? 0}
              onBlur={(e) => onPercentChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
              style={{ width: 80, textAlign: 'right' }}
              title="Commits on blur or Enter. Other groups don't change — use Auto-balance to redistribute evenly."
            />
          </Field>
        ) : (
          <Field label="Cases">
            <input
              type="number" min={0}
              value={group.casesCount ?? 0}
              onChange={(e) => onChange({ casesCount: Math.max(0, Math.floor(+e.target.value || 0)) })}
              style={{ width: 80, textAlign: 'right' }}
            />
          </Field>
        )}

        {/* Carrier */}
        <Field label="Carrier">
          <select
            value={group.carrierType}
            onChange={(e) => onChange({ carrierType: e.target.value })}
            style={{ fontSize: 12 }}
          >
            {CARRIER_TYPES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </Field>

        {/* SKU (straight only) */}
        {group.type === 'straight' && (
          <Field label="SKU">
            <select
              value={group.skuId || ''}
              onChange={(e) => onChange({ skuId: e.target.value })}
              style={{ fontSize: 12 }}
            >
              <option value="">— select —</option>
              {(flavorRows || []).map((f) => <option key={f.id} value={f.id}>{f.name || '(unnamed)'}</option>)}
            </select>
          </Field>
        )}

        {/* Derived display: cases · packs · cans */}
        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          → <strong style={{ color: 'var(--text-primary)' }}>{fmt(cases)}</strong> cases
          {' · '}
          <strong style={{ color: 'var(--text-primary)' }}>{fmt(packs)}</strong> packs
          {' · '}
          <strong style={{ color: 'var(--text-primary)' }}>{fmt(consumed)}</strong> cans
        </div>
      </div>

      {/* Variety mix */}
      {group.type === 'variety' && (
        <VarietyMixEditor
          group={group}
          flavorRows={flavorRows}
          onMixChange={onMixChange}
        />
      )}
    </div>
  );
}

function VarietyMixEditor({ group, flavorRows, onMixChange }) {
  const mixById = useMemo(() => {
    const m = {};
    (group.mix || []).forEach((row) => { m[row.skuId] = row.cans || 0; });
    return m;
  }, [group.mix]);
  const sum = Object.values(mixById).reduce((s, v) => s + (v || 0), 0);
  const sumOk = sum === group.packSize;
  return (
    <div style={{ marginTop: 10, padding: 10, background: 'white', border: '1px dashed var(--border-light)', borderRadius: 6 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
        Mix per pack (must sum to {group.packSize})
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
        {(flavorRows || []).map((f) => (
          <label key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <span style={{ flex: 1, color: 'var(--text-primary)' }}>{f.name || '(unnamed)'}</span>
            <input
              type="number"
              min={0}
              value={mixById[f.id] || 0}
              onChange={(e) => onMixChange(f.id, Math.max(0, Math.floor(+e.target.value || 0)))}
              style={{ width: 60, textAlign: 'right' }}
            />
          </label>
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: sumOk ? '#15803d' : '#b91c1c', fontWeight: 600 }}>
        Total: {sum} / {group.packSize} {sumOk ? '✓' : '✗'}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      {children}
    </label>
  );
}

function SectionLabel({ children, inline = false }) {
  return (
    <div style={{
      fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase',
      letterSpacing: 0.5, marginBottom: inline ? 0 : 8,
    }}>{children}</div>
  );
}

// ── Inline styles ──

const th = { textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '6px 8px', borderBottom: '1px solid var(--border-light)' };
const thRight = { ...th, textAlign: 'right' };
const td = { padding: '6px 8px', fontSize: 13, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-light)' };
const tdRight = { ...td, textAlign: 'right' };
const chip = { padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700 };

function fmt(n) {
  if (n == null || Number.isNaN(n)) return '0';
  return Number(n).toLocaleString();
}
