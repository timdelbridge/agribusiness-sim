/**
 * Agribusiness Sim — PDF report generation
 *
 * Builds real, emailable .pdf files (not "print to PDF") using the locally
 * vendored jsPDF + jsPDF-AutoTable (vendor/jspdf.umd.min.js and
 * vendor/jspdf.plugin.autotable.min.js — MIT licensed, no CDN/network
 * dependency at runtime). Depends on those two scripts plus app.js
 * (for AppState.buildReportPayload / buildInstructorSummaryPayload)
 * being loaded first.
 */

const PDF_PRODUCT_LABELS = {
  completeFeed: 'Complete Feed',
  concentrateFeed: 'Concentrate Feed',
  commGradeFert: 'Comm. Grade Fert',
  customBlendFert: 'Custom Blend Fert',
};
const PDF_PRODUCTS = ['completeFeed', 'concentrateFeed', 'commGradeFert', 'customBlendFert'];

function money(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function tons(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function pct(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `${n.toFixed(1)}%`;
}
function sanitizeForFilename(s) {
  return String(s).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
}
// Team objects differ in shape between the local-file app ({teamId, teamName})
// and the hosted Firebase app ({id, name}) -- this file is shared by both, so
// every place that touches a team object goes through these two helpers.
function teamLabel(t) { return t.teamName || t.name; }
function teamKey(t) { return t.teamId || t.id; }

function teamReportFilename(payload) {
  return `TeamReport_${sanitizeForFilename(payload.teamName)}_${sanitizeForFilename(payload.quarterLabel)}.pdf`;
}
function instructorSummaryFilename(payload) {
  return `InstructorSummary_${sanitizeForFilename(payload.quarterLabel)}.pdf`;
}

const AUTOTABLE_THEME = {
  headStyles: { fillColor: [47, 109, 58], textColor: 255, fontSize: 9 },
  styles: { fontSize: 9, cellPadding: 4 },
  margin: { left: 40, right: 40 },
};

function newDoc() {
  const { jsPDF } = window.jspdf;
  return new jsPDF({ unit: 'pt', format: 'letter' });
}

function addRunningHeader(doc, lines) {
  doc.setFontSize(9);
  doc.setTextColor(90, 100, 90);
  doc.text(lines.join('  |  '), 40, 28);
  doc.setTextColor(0, 0, 0);
}

function addSectionTitle(doc, title, y) {
  doc.setFontSize(13);
  doc.setTextColor(30, 42, 30);
  doc.text(title, 40, y);
  doc.setTextColor(0, 0, 0);
  return y + 14;
}

function stampFooters(doc) {
  const pageCount = doc.internal.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(140, 140, 140);
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - 90, pageHeight - 24);
    doc.setTextColor(0, 0, 0);
  }
}

// ============================================================
// MARKET SHARE REPORT (shared by team reports and the instructor summary --
// matches the classic Purdue simulation manual layout: teams as columns)
// ============================================================

function addMarketShareReportSection(doc, marketReport, teams, startY) {
  let y = addSectionTitle(doc, 'Market Share Report', startY);
  const teamLabels = teams.map(teamLabel);
  const totalMarketTons = marketReport.teamSummaries.reduce((sum, ts) => sum + ts.totalSalesTons, 0);

  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Price Per Ton', ...teamLabels]],
    body: PDF_PRODUCTS.map(p => [PDF_PRODUCT_LABELS[p], ...marketReport.teamSummaries.map(ts => money(ts.prices[p]))]),
  });

  y = doc.lastAutoTable.finalY + 16;
  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Product', 'Avg Price', 'Next Qtr Min', 'Next Qtr Max', 'Wholesale']],
    body: PDF_PRODUCTS.map(p => [
      PDF_PRODUCT_LABELS[p],
      money(marketReport.currentAvgPrices[p]),
      money(marketReport.nextQtrPriceLimits[p].min),
      money(marketReport.nextQtrPriceLimits[p].max),
      money(marketReport.wholesalePrices[p]),
    ]),
  });

  y = doc.lastAutoTable.finalY + 16;
  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Advertising', ...teamLabels]],
    body: [['', ...marketReport.teamSummaries.map(ts => money(ts.advertising))]],
  });

  y = doc.lastAutoTable.finalY + 16;
  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Sales by Team (Tons)', ...teamLabels]],
    body: [
      ...PDF_PRODUCTS.map(p => [PDF_PRODUCT_LABELS[p], ...marketReport.teamSummaries.map(ts => tons(ts.salesTons[p]))]),
      ['Total', ...marketReport.teamSummaries.map(ts => tons(ts.totalSalesTons))],
    ],
    didParseCell: (data) => { if (data.row.index === PDF_PRODUCTS.length) data.cell.styles.fontStyle = 'bold'; },
  });

  y = doc.lastAutoTable.finalY + 16;
  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Share of Market (%)', ...teamLabels]],
    body: [
      ...PDF_PRODUCTS.map(p => [PDF_PRODUCT_LABELS[p], ...marketReport.teamSummaries.map(ts => pct(ts.marketShare[p]))]),
      ['Total', ...marketReport.teamSummaries.map(ts => pct(totalMarketTons > 0 ? (ts.totalSalesTons / totalMarketTons) * 100 : 0))],
    ],
    didParseCell: (data) => { if (data.row.index === PDF_PRODUCTS.length) data.cell.styles.fontStyle = 'bold'; },
  });

  return doc.lastAutoTable.finalY;
}

// ============================================================
// TEAM REPORT
// ============================================================

function buildTeamReportPdf(payload) {
  const { teamName, quarterLabel, interestScenario, report, marketReport, teams } = payload;
  const headerLines = [teamName, quarterLabel, `Scenario ${interestScenario}`];
  const doc = newDoc();

  doc.setFontSize(18);
  doc.text(`${teamName} — Quarterly Report`, 40, 50);
  doc.setFontSize(11);
  doc.setTextColor(90, 100, 90);
  doc.text(`${quarterLabel}  •  Interest Rate Scenario ${interestScenario}`, 40, 68);
  doc.setTextColor(0, 0, 0);

  // --- Income Statement ---
  let y = 100;
  y = addSectionTitle(doc, 'Income Statement', y);
  const revenueRows = PDF_PRODUCTS.map(p => [PDF_PRODUCT_LABELS[p], tons(report.actualSales[p]), money(report.revenue[p])]);
  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Product', 'Tons Sold', 'Revenue']],
    body: [
      ...revenueRows,
      ['Total Revenue', tons(report.totalSalesTons), money(report.totalRevenue)],
    ],
    didParseCell: (data) => { if (data.row.index === revenueRows.length) data.cell.styles.fontStyle = 'bold'; },
  });

  y = doc.lastAutoTable.finalY + 20;
  const cogsRows = PDF_PRODUCTS.map(p => [PDF_PRODUCT_LABELS[p], money(report.cogs[p])]);
  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Cost of Goods Sold', 'Amount']],
    body: [
      ...cogsRows,
      ['Total COGS', money(report.totalCOGS)],
      ['Gross Margin', money(report.grossMargin)],
    ],
    didParseCell: (data) => { if (data.row.index >= cogsRows.length) data.cell.styles.fontStyle = 'bold'; },
  });

  y = doc.lastAutoTable.finalY + 20;
  const exp = report.expenses;
  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Operating Expenses', 'Amount']],
    body: [
      ['Storage — Fixed (Depreciation)', money(exp.storageFCost)],
      ['Storage — Variable', money(exp.storageVCost)],
      ['Storage — Rental', money(exp.storageRentalCost)],
      ['Truck — Fixed (Depreciation)', money(exp.truckFCost)],
      ['Truck — Variable', money(exp.truckVCost)],
      ['Truck — Rental', money(exp.truckRentalCost)],
      ['Manager Salary', money(exp.managerSalary)],
      ['Labor (incl. training)', money(exp.laborCost)],
      ['Overtime', money(exp.overtimeCost)],
      ['Bad Debt', money(exp.badDebt)],
      ['Advertising', money(exp.advertising)],
      ['Misc. Expenses', money(exp.miscExpenses)],
      ['Total Operating Expenses', money(report.totalOperatingExpenses)],
    ],
    didParseCell: (data) => { if (data.row.index === 12) data.cell.styles.fontStyle = 'bold'; },
  });

  y = doc.lastAutoTable.finalY + 20;
  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Net Profit Summary', 'Amount']],
    body: [
      ['Net Operating Profit', money(report.netOperatingProfit)],
      ['Investment Income', money(report.investmentIncome)],
      ['Interest Expense', money(-report.interestExpense)],
      ['Net Profit Before Tax', money(report.netProfitBeforeTax)],
      ['Gross Margin %', pct(report.ratios.grossMarginPct)],
      ['Net Profit %', pct(report.ratios.netProfitPct)],
    ],
    didParseCell: (data) => { if (data.row.index === 3) data.cell.styles.fontStyle = 'bold'; },
  });

  // --- Balance Sheet ---
  doc.addPage();
  y = addSectionTitle(doc, 'Balance Sheet', 60);
  const s = report.newState;
  const inventoryValue = PDF_PRODUCTS.reduce((sum, p) => sum + s.inventory[p].value, 0);
  const totalAssets = s.cash + s.accountsReceivable + s.investments + inventoryValue + s.storageBookValue + s.truckBookValue;
  const totalLiabilities = s.bankNote + s.emergencyLoan;

  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Assets', 'Amount']],
    body: [
      ['Cash', money(s.cash)],
      ['Accounts Receivable', money(s.accountsReceivable)],
      ['Investments', money(s.investments)],
      ...PDF_PRODUCTS.map(p => [`Inventory — ${PDF_PRODUCT_LABELS[p]} (${tons(s.inventory[p].tons)} tons)`, money(s.inventory[p].value)]),
      ['Storage — Net Book Value', money(s.storageBookValue)],
      ['Trucks — Net Book Value', money(s.truckBookValue)],
      ['Total Assets', money(totalAssets)],
    ],
    didParseCell: (data) => { if (data.row.index === data.table.body.length - 1) data.cell.styles.fontStyle = 'bold'; },
  });

  y = doc.lastAutoTable.finalY + 20;
  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Liabilities & Equity', 'Amount']],
    body: [
      ['Bank Note Payable', money(s.bankNote)],
      ['Emergency Loan', money(s.emergencyLoan)],
      ['Total Liabilities', money(totalLiabilities)],
      ['Owner’s Equity', money(s.equity)],
      ['Total Liabilities & Equity', money(totalLiabilities + s.equity)],
    ],
    didParseCell: (data) => { if ([2, 4].includes(data.row.index)) data.cell.styles.fontStyle = 'bold'; },
  });

  y = doc.lastAutoTable.finalY + 20;
  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Key Ratios', 'Value']],
    body: [
      ['Current Ratio', report.ratios.currentRatio.toFixed(2)],
      ['Debt / Equity Ratio', report.ratios.debtEquityRatio.toFixed(2)],
      ['Trucks Owned', String(s.trucksOwned)],
      ['Storage Owned (sqft)', s.storageSqft.toLocaleString()],
      ['Workers Employed', String(s.workersEmployed)],
    ],
  });

  // --- Cash Flow ---
  doc.addPage();
  y = addSectionTitle(doc, 'Cash Flow Statement', 60);
  const cf = report.cashFlow;
  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Cash In', 'Amount']],
    body: [
      ['Beginning Cash', money(cf.beginCash)],
      ['Collected This Quarter (current sales)', money(cf.currentQtrCollected)],
      ['Collected From Prior Quarter A/R', money(cf.collectedFromLastQtr)],
      ['Investment Income', money(cf.investmentIncome)],
      ['Borrowed', money(cf.borrowed)],
      ['Investment Called', money(cf.investmentCalled)],
      ['Total Cash In', money(cf.totalCashIn)],
    ],
    didParseCell: (data) => { if (data.row.index === 6) data.cell.styles.fontStyle = 'bold'; },
  });

  y = doc.lastAutoTable.finalY + 20;
  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Cash Out', 'Amount']],
    body: [
      ['Product Purchases', money(cf.productPurchaseCost)],
      ['Total Cash Out', money(cf.totalCashOut)],
      ['Ending Cash', money(cf.endCash)],
    ],
    didParseCell: (data) => { if (data.row.index >= 1) data.cell.styles.fontStyle = 'bold'; },
  });

  // --- Market Share / Utilization ---
  y = doc.lastAutoTable.finalY + 20;
  y = addSectionTitle(doc, 'Sales, Pricing & Utilization', y);
  const util = report.utilization;
  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Product', 'Your Price', 'Tons Sold', 'Tons Unfilled']],
    body: PDF_PRODUCTS.map(p => [
      PDF_PRODUCT_LABELS[p],
      money(s.prices[p]),
      tons(report.actualSales[p]),
      tons(report.unfilledOrders[p]),
    ]),
  });

  y = doc.lastAutoTable.finalY + 20;
  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Utilization', 'Value']],
    body: [
      ['Storage Utilization', pct(util.storageUtilization)],
      ['Truck Utilization', pct(util.truckUtilization)],
      ['Labor Utilization', pct(util.laborUtilization)],
    ],
  });

  // --- Market Share Report (only when the market-wide round data was
  // supplied alongside this team's own report) ---
  if (marketReport && teams) {
    doc.addPage();
    addMarketShareReportSection(doc, marketReport, teams, 60);
  }

  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    addRunningHeader(doc, headerLines);
  }
  stampFooters(doc);

  return doc;
}

// ============================================================
// INSTRUCTOR SUMMARY
// ============================================================

function buildInstructorSummaryPdf(payload) {
  const { quarterLabel, interestScenario, teams, marketReport, teamReports } = payload;
  const headerLines = [`Instructor Summary`, quarterLabel, `Scenario ${interestScenario}`];
  const doc = newDoc();

  doc.setFontSize(18);
  doc.text('Instructor Quarterly Summary', 40, 50);
  doc.setFontSize(11);
  doc.setTextColor(90, 100, 90);
  doc.text(`${quarterLabel}  •  Interest Rate Scenario ${interestScenario}`, 40, 68);
  doc.setTextColor(0, 0, 0);

  let y = 100;
  y = addSectionTitle(doc, 'Team Comparison', y);
  const rows = teams.map(t => {
    const r = teamReports[teamKey(t)];
    return [
      teamLabel(t),
      tons(r.totalSalesTons),
      money(r.totalRevenue),
      money(r.netProfitBeforeTax),
      money(r.newState.cash),
      money(r.newState.equity),
      pct(r.ratios.debtEquityRatio * 100),
    ];
  });
  doc.autoTable({
    ...AUTOTABLE_THEME,
    startY: y,
    head: [['Team', 'Tons Sold', 'Revenue', 'Net Profit', 'Cash', 'Equity', 'Debt/Equity']],
    body: rows,
  });

  doc.addPage();
  addMarketShareReportSection(doc, marketReport, teams, 60);

  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    addRunningHeader(doc, headerLines);
  }
  stampFooters(doc);

  return doc;
}

// ============================================================
// DOWNLOAD HELPERS
// ============================================================

function downloadTeamReportPdf(payload) {
  const doc = buildTeamReportPdf(payload);
  doc.save(teamReportFilename(payload));
}

function downloadInstructorSummaryPdf(payload) {
  const doc = buildInstructorSummaryPdf(payload);
  doc.save(instructorSummaryFilename(payload));
}

/**
 * Generates and downloads every team's report PDF plus the instructor
 * summary PDF for a given processed quarter. Small delay between saves
 * to avoid browsers' "multiple automatic downloads" blocking prompt.
 */
async function generateAllReportPdfs(gameState, quarterIndex) {
  for (const team of gameState.teams) {
    const payload = AppState.buildReportPayload(gameState, team.teamId, quarterIndex);
    downloadTeamReportPdf(payload);
    await new Promise(r => setTimeout(r, 200));
  }
  const summaryPayload = AppState.buildInstructorSummaryPayload(gameState, quarterIndex);
  downloadInstructorSummaryPdf(summaryPayload);
}

// ============================================================
// EXPORTS
// ============================================================

const PdfReports = {
  buildTeamReportPdf,
  buildInstructorSummaryPdf,
  teamReportFilename,
  instructorSummaryFilename,
  downloadTeamReportPdf,
  downloadInstructorSummaryPdf,
  generateAllReportPdfs,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PdfReports;
} else if (typeof window !== 'undefined') {
  window.PdfReports = PdfReports;
}
