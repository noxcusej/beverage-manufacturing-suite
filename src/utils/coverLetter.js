// Generates a plain-English "cover letter" from a Summary run.
//
// Produces two outputs in parallel:
//   - HTML (for upload as a Google Doc — Drive API parses h1/h2/p/ul/table)
//   - Plain text (for the editable textarea + clipboard / .txt download)
//
// "Dumbed down" = no jargon, no formula codes. Reads like an email to a
// client who doesn't know what "tolling" or "FOB" means without context.

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
 * @param {object} args.pricing          - { fob, distributorPrice, retailPrice, distributorMargin, retailMargin, grossMargin }
 * @param {string} [args.fromName]       - sender name (optional)
 * @param {string} [args.fromCompany]    - sender company (optional)
 * @returns {{ html: string, text: string, title: string }}
 */
export function generateCoverLetter({ run, data, pricing, fromName, fromCompany } = {}) {
  if (!run || !data) {
    return { html: '', text: '', title: 'Cover Letter' };
  }

  const clientName = run.client || 'your team';
  const runName = run.name || 'Untitled run';
  const date = todayLong();
  const { totalCases, totalCans, totalPallets, flavorCount, packSize, unitsPerCase, costPerCase, costPerUnit } = data;
  const { fob, distributorPrice, retailPrice, distributorMargin, retailMargin, grossMargin } = pricing || {};
  const flavorList = (data.flavorData || []).map((f) => f.name).filter(Boolean);

  const title = `${runName} — Cover Letter`;
  const signature = (fromName || fromCompany)
    ? `${fromName ? `\n${fromName}` : ''}${fromCompany ? `\n${fromCompany}` : ''}`
    : '';

  // ── Plain-text version (textarea + clipboard + .txt) ──
  const textLines = [
    `${date}`,
    '',
    `Hi ${clientName},`,
    '',
    `Here's a quick summary of the "${runName}" production run.`,
    '',
    "WHAT WE'RE MAKING",
    `• ${int(totalCases)} cases (${int(totalCans)} cans) of ${flavorCount} flavor${flavorCount === 1 ? '' : 's'}${flavorList.length > 0 ? `: ${flavorList.join(', ')}` : ''}`,
    `• ${packSize}-packs, ${unitsPerCase} cans per case`,
    `• ${int(totalPallets)} pallet${totalPallets === 1 ? '' : 's'} total`,
    '',
    'WHAT IT COSTS US TO MAKE',
    `• $${money(costPerCase)} per case (about $${money(costPerUnit, 3)} per can)`,
    '',
    'WHAT WE RECOMMEND YOU CHARGE',
    fob > 0 ? `• Sell to distributor: $${money(fob)} per case` : null,
    distributorPrice > 0 ? `• Distributor sells to retail: $${money(distributorPrice)} per case (${distributorMargin}% margin for them)` : null,
    retailPrice > 0 ? `• Suggested shelf price: $${money(retailPrice / unitsPerCase * packSize)} per ${packSize}-pack (${retailMargin}% margin for the retailer)` : null,
    '',
    'WHAT YOU EARN',
    fob > 0 ? `• $${money(fob - costPerCase)} profit per case (${grossMargin.toFixed(1)}% margin) before distribution costs` : null,
    '',
    "Let me know if you'd like to tweak any of the assumptions — happy to rerun the numbers with different volume, pricing, or pack configuration.",
    '',
    'Thanks,',
    signature.trim() || '[Your name]',
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

  <h1>${escapeHtml(runName)} — Quote Summary</h1>

  <p>Hi ${escapeHtml(clientName)},</p>

  <p>Here's a quick summary of the <strong>${escapeHtml(runName)}</strong> production run.</p>

  <h2>What we're making</h2>
  <ul>
    <li><strong>${int(totalCases)} cases</strong> (${int(totalCans)} cans) of <strong>${flavorCount} flavor${flavorCount === 1 ? '' : 's'}</strong>${flavorList.length > 0 ? `: ${escapeHtml(flavorList.join(', '))}` : ''}</li>
    <li>${packSize}-packs, ${unitsPerCase} cans per case</li>
    <li><strong>${int(totalPallets)} pallet${totalPallets === 1 ? '' : 's'}</strong> total</li>
  </ul>

  <h2>What it costs us to make</h2>
  <ul>
    <li><strong>$${money(costPerCase)}</strong> per case (about $${money(costPerUnit, 3)} per can)</li>
  </ul>

  <h2>What we recommend you charge</h2>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
    <tr style="background:#f3f4f6;font-weight:600;">
      <td>Channel</td>
      <td style="text-align:right;">Per Case</td>
      <td style="text-align:right;">Per ${packSize}-pack</td>
      <td style="text-align:right;">Margin</td>
    </tr>
    ${fob > 0 ? `
    <tr>
      <td>You → Distributor (FOB)</td>
      <td style="text-align:right;">$${money(fob)}</td>
      <td style="text-align:right;">$${money(fob / unitsPerCase * packSize)}</td>
      <td style="text-align:right;">${grossMargin.toFixed(1)}%</td>
    </tr>` : ''}
    ${distributorPrice > 0 ? `
    <tr>
      <td>Distributor → Retailer</td>
      <td style="text-align:right;">$${money(distributorPrice)}</td>
      <td style="text-align:right;">$${money(distributorPrice / unitsPerCase * packSize)}</td>
      <td style="text-align:right;">${distributorMargin}%</td>
    </tr>` : ''}
    ${retailPrice > 0 ? `
    <tr>
      <td>Retailer → Consumer (MSRP)</td>
      <td style="text-align:right;">$${money(retailPrice)}</td>
      <td style="text-align:right;"><strong>$${money(retailPrice / unitsPerCase * packSize)}</strong></td>
      <td style="text-align:right;">${retailMargin}%</td>
    </tr>` : ''}
  </table>

  ${fob > 0 ? `
  <h2>What you earn</h2>
  <p>At <strong>$${money(fob)}</strong> per case to the distributor, you net <strong>$${money(fob - costPerCase)}</strong> per case (${grossMargin.toFixed(1)}% gross margin) before distribution costs.</p>
  ` : ''}

  <p>Let me know if you'd like to tweak any of the assumptions — happy to rerun the numbers with different volume, pricing, or pack configuration.</p>

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
