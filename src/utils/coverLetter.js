// Generates a sales-focused cover letter from a Summary run.
//
// Co-packer pitching the brand client. References the run as the quote.
// The headline content is the PACKAGING PLAN — what's actually being
// produced: per-group breakdown with flavor, pack size, carrier, and
// case count. Downstream client economics (distributor/retail margins,
// "what you earn") are intentionally absent.
//
// Two outputs in parallel:
//   - HTML (for upload as a Google Doc — Drive API parses headings/tables)
//   - Plain text (for the editable textarea + clipboard / .txt download)

function money(n, digits = 2) {
  return (n || 0).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function int(n) {
  return Math.round(n || 0).toLocaleString();
}

function todayLong() {
  return new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function carrierLabel(c) {
  if (c === 'paktech') return 'PakTech';
  if (c === 'carton') return 'Carton';
  if (c === 'shrink') return 'Shrink-wrap';
  if (c === 'none') return 'No carrier';
  return c || '';
}

/**
 * Resolve a pack-group into a sales-friendly line:
 *   { label, sublabel, cases, packs, carrier }
 *
 * Straight group → "Cherry Whiskey · 4-pack · PakTech"
 * Variety group → "Variety 8-pack (Cherry / Lime / Mint) · Carton"
 */
function describeGroup(g, flavorRows) {
  const flavorById = Object.fromEntries((flavorRows || []).map((f) => [f.id, f]));
  const carrier = carrierLabel(g.carrierType);
  if (g.type === 'variety') {
    const mixNames = (g.mix || [])
      .filter((m) => (m.cans || 0) > 0)
      .map((m) => flavorById[m.skuId]?.name || m.skuId)
      .filter(Boolean);
    const baseLabel = g.label || `Variety ${g.packSize}-pack`;
    const mixSuffix = mixNames.length > 0 ? ` (${mixNames.join(' / ')})` : '';
    return {
      label: baseLabel + mixSuffix,
      packConfig: `${g.packSize}-pack`,
      carrier,
      cases: g.casesConsumed || 0,
      packs: g.packsCount || 0,
    };
  }
  const flavorName = flavorById[g.skuId]?.name;
  const baseLabel = g.label || (flavorName ? `${flavorName} ${g.packSize}-pack` : `Straight ${g.packSize}-pack`);
  return {
    label: baseLabel,
    packConfig: `${g.packSize}-pack`,
    carrier,
    cases: g.casesConsumed || 0,
    packs: g.packsCount || 0,
  };
}

/**
 * @param {object} args
 * @param {object} args.run              - selected saved run
 * @param {object} args.data             - deriveSummary() output (with planDerived, flavorRows)
 * @param {object} args.pricing          - { fob } — per-case quote price
 * @param {string} [args.fromName]
 * @param {string} [args.fromCompany]
 * @returns {{ html: string, text: string, title: string }}
 */
export function generateCoverLetter({ run, data, pricing, fromName, fromCompany } = {}) {
  if (!run || !data) {
    return { html: '', text: '', title: 'Cover Letter' };
  }

  const clientName = run.client || 'your team';
  const runName = run.name || 'Untitled quote';
  const date = todayLong();
  const { totalCases, totalCans, totalPallets, packSize, unitsPerCase, planDerived, flavorRows } = data;

  const quotePerCase = (pricing?.fob && pricing.fob > 0) ? pricing.fob : (data.costPerCase || 0);
  const pricePerPack = unitsPerCase > 0 ? quotePerCase / unitsPerCase * packSize : 0;
  const pricePerCan = unitsPerCase > 0 ? quotePerCase / unitsPerCase : 0;
  const projectTotal = quotePerCase * totalCases;

  // Build the packaging-plan line items. If a plan is active, use its
  // groups (real per-group breakdown). Otherwise fall back to the
  // single legacy line ("X cases of Y-pack").
  const groups = (planDerived?.active && Array.isArray(planDerived.groups))
    ? planDerived.groups.filter((g) => (g.casesConsumed || 0) > 0).map((g) => describeGroup(g, flavorRows))
    : [{
        label: `${packSize}-pack run`,
        packConfig: `${packSize}-pack`,
        carrier: '',
        cases: totalCases,
        packs: 0,
      }];

  const title = `${runName} — Co-Pack Quote`;
  const senderLine = fromName || '[Your name]';
  const companyLine = fromCompany ? `\n${fromCompany}` : '';

  // ── Plain-text version ──
  const groupTextLines = groups.map((gr) => {
    const carrierBit = gr.carrier ? ` · ${gr.carrier}` : '';
    return `• ${int(gr.cases)} cases — ${gr.label}${gr.label.includes('-pack') ? '' : ` · ${gr.packConfig}`}${carrierBit}`;
  });

  const textLines = [
    date,
    '',
    `Hi ${clientName},`,
    '',
    `Thanks for the opportunity to quote ${runName}. Here's what we're proposing to produce for you:`,
    '',
    'THE RUN',
    ...groupTextLines,
    '',
    `Totals: ${int(totalCases)} cases · ${int(totalCans)} cans · ${int(totalPallets)} pallet${totalPallets === 1 ? '' : 's'}`,
    '',
    'THE QUOTE',
    `• $${money(quotePerCase)} per case`,
    pricePerPack > 0 ? `• $${money(pricePerPack)} per ${packSize}-pack` : null,
    pricePerCan > 0 ? `• $${money(pricePerCan, 3)} per can` : null,
    projectTotal > 0 ? `• Project total: $${money(projectTotal)}` : null,
    '',
    'All-in: ingredients, packaging, co-pack, palletizing. Ready to schedule production whenever you are.',
    '',
    "Let me know if you'd like to adjust the volume, pack config, or any other piece — happy to rerun the numbers.",
    '',
    'Thanks,',
    `${senderLine}${companyLine}`,
  ].filter((l) => l !== null);
  const text = textLines.join('\n');

  // ── HTML version (Google Doc) ──
  const groupRowsHtml = groups.map((gr) => `
    <tr>
      <td>${escapeHtml(gr.label)}</td>
      <td>${escapeHtml(gr.carrier || '—')}</td>
      <td style="text-align:right;"><strong>${int(gr.cases)}</strong></td>
      <td style="text-align:right;">${gr.packs > 0 ? int(gr.packs) : '—'}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <p style="color:#6b7280;font-size:11pt;">${escapeHtml(date)}</p>

  <h1>${escapeHtml(runName)}</h1>
  <p style="color:#6b7280;">Co-Pack Quote</p>

  <p>Hi ${escapeHtml(clientName)},</p>

  <p>Thanks for the opportunity to quote <strong>${escapeHtml(runName)}</strong>. Here's what we're proposing to produce for you:</p>

  <h2>The run</h2>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
    <tr style="background:#f3f4f6;font-weight:600;">
      <td>SKU / Pack</td>
      <td>Carrier</td>
      <td style="text-align:right;">Cases</td>
      <td style="text-align:right;">Packs</td>
    </tr>
    ${groupRowsHtml}
    <tr style="background:#f9fafb;font-weight:700;">
      <td colspan="2">Totals</td>
      <td style="text-align:right;">${int(totalCases)}</td>
      <td style="text-align:right;">—</td>
    </tr>
  </table>
  <p style="color:#6b7280;font-size:10pt;">${int(totalCans)} cans total · ${int(totalPallets)} pallet${totalPallets === 1 ? '' : 's'} finished</p>

  <h2>The quote</h2>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
    <tr style="background:#f3f4f6;font-weight:600;">
      <td>Unit</td>
      <td style="text-align:right;">Price</td>
    </tr>
    <tr>
      <td>Per case</td>
      <td style="text-align:right;"><strong>$${money(quotePerCase)}</strong></td>
    </tr>
    ${pricePerPack > 0 ? `
    <tr>
      <td>Per ${packSize}-pack</td>
      <td style="text-align:right;">$${money(pricePerPack)}</td>
    </tr>` : ''}
    ${pricePerCan > 0 ? `
    <tr>
      <td>Per can</td>
      <td style="text-align:right;">$${money(pricePerCan, 3)}</td>
    </tr>` : ''}
    ${projectTotal > 0 ? `
    <tr style="background:#f9fafb;font-weight:600;">
      <td>Project total</td>
      <td style="text-align:right;">$${money(projectTotal)}</td>
    </tr>` : ''}
  </table>

  <p style="color:#374151;">All-in: ingredients, packaging, co-pack, palletizing. Ready to schedule production whenever you are.</p>

  <p>Let me know if you'd like to adjust the volume, pack config, or any other piece — happy to rerun the numbers.</p>

  <p>Thanks,<br/>
  ${escapeHtml(fromName || '[Your name]')}${fromCompany ? `<br/>${escapeHtml(fromCompany)}` : ''}</p>
</body>
</html>`;

  return { html, text, title };
}

function escapeHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
