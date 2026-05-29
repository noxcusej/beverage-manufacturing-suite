// Generates a sales-focused cover letter from a Summary run.
//
// Framing: the co-packer is pitching the brand client. The letter
// references the run quote, summarizes what we're proposing to produce
// for them, and gives a clean per-case / per-pack price. Downstream
// economics (distributor margin, retail MSRP, the client's profit) are
// deliberately omitted — those aren't ours to set.
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

/**
 * @param {object} args
 * @param {object} args.run              - selected saved run
 * @param {object} args.data             - computeRunResults() output
 * @param {object} args.pricing          - { fob } — per-case quote price
 * @param {string} [args.fromName]       - sender name (optional)
 * @param {string} [args.fromCompany]    - sender company (optional)
 * @returns {{ html: string, text: string, title: string }}
 */
export function generateCoverLetter({ run, data, pricing, fromName, fromCompany } = {}) {
  if (!run || !data) {
    return { html: '', text: '', title: 'Cover Letter' };
  }

  const clientName = run.client || 'your team';
  const runName = run.name || 'Untitled quote';
  const date = todayLong();
  const { totalCases, totalCans, totalPallets, flavorCount, packSize, unitsPerCase } = data;
  const quotePerCase = (pricing?.fob && pricing.fob > 0) ? pricing.fob : (data.costPerCase || 0);
  const pricePerPack = unitsPerCase > 0 ? quotePerCase / unitsPerCase * packSize : 0;
  const pricePerCan = unitsPerCase > 0 ? quotePerCase / unitsPerCase : 0;
  const projectTotal = quotePerCase * totalCases;
  const flavorList = (data.flavorData || []).map((f) => f.name).filter(Boolean);

  const title = `${runName} — Co-Pack Quote`;
  const senderLine = fromName || '[Your name]';
  const companyLine = fromCompany ? `\n${fromCompany}` : '';

  // ── Plain-text version ──
  const textLines = [
    date,
    '',
    `Hi ${clientName},`,
    '',
    `Thanks for the opportunity to quote ${runName}. Here's what we're proposing to produce for you:`,
    '',
    'THE RUN',
    `• ${int(totalCases)} cases (${int(totalCans)} cans) across ${flavorCount} SKU${flavorCount === 1 ? '' : 's'}${flavorList.length > 0 ? `: ${flavorList.join(', ')}` : ''}`,
    `• ${packSize}-packs, ${unitsPerCase} cans per case`,
    `• ${int(totalPallets)} pallet${totalPallets === 1 ? '' : 's'} finished`,
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
  <ul>
    <li><strong>${int(totalCases)} cases</strong> (${int(totalCans)} cans) across <strong>${flavorCount} SKU${flavorCount === 1 ? '' : 's'}</strong>${flavorList.length > 0 ? `: ${escapeHtml(flavorList.join(', '))}` : ''}</li>
    <li>${packSize}-packs, ${unitsPerCase} cans per case</li>
    <li><strong>${int(totalPallets)} pallet${totalPallets === 1 ? '' : 's'}</strong> finished</li>
  </ul>

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
