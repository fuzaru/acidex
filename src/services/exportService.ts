import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

import { AnalysisRecord } from "../types/analysis";

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function shareAnalysisPdf(record: AnalysisRecord): Promise<void> {
  const narrative = record.narrative;

  const html = `
  <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no" />
      <style>
        body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; color: #2E211B; background-color: #FFFFFF; line-height: 1.5; }
        .header { border-bottom: 2px solid #8B5E3C; padding-bottom: 20px; margin-bottom: 30px; }
        .title { font-size: 28px; font-weight: bold; margin: 0; color: #8B5E3C; }
        .subtitle { font-size: 16px; color: #7A675C; margin-top: 5px; }
        .section { margin-bottom: 25px; }
        .section-title { font-size: 18px; font-weight: bold; color: #3C2C24; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 1px; border-left: 4px solid #8B5E3C; padding-left: 10px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
        .card { background-color: #FDF6F0; border: 1px solid #E8D5C4; border-radius: 12px; padding: 15px; }
        .label { font-size: 12px; color: #8B6A55; text-transform: uppercase; font-weight: bold; }
        .value { font-size: 16px; font-weight: 600; color: #2E211B; }
        .summary { font-size: 16px; font-style: italic; color: #4B3A33; background-color: #F4EEEA; padding: 15px; border-radius: 12px; }
        ul { padding-left: 20px; margin: 0; }
        li { margin-bottom: 8px; color: #4E3D35; }
        .disclaimer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #EDE3DC; font-size: 12px; color: #8B6A55; text-align: center; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1 class="title">Acidex Analysis Report</h1>
        <p class="subtitle">${esc(record.coffeeType)} • ${new Date(record.createdAt).toLocaleString("en-US")}</p>
      </div>

      <div class="section">
        <div class="grid">
          <div class="card">
            <div class="label">Acidity Reading</div>
            <div class="value">pH ${record.ph.toFixed(2)}</div>
          </div>
          <div class="card">
            <div class="label">Classification</div>
            <div class="value">${esc(record.classification)}</div>
          </div>
          <div class="card">
            <div class="label">Risk Level</div>
            <div class="value">${esc(record.riskLevel ?? "Low Risk")}</div>
          </div>
          <div class="card">
            <div class="label">Stomach State</div>
            <div class="value">${esc(record.stomachState ?? "Not logged")}</div>
          </div>
        </div>
      </div>

      ${narrative?.summary ? `
      <div class="section">
        <div class="section-title">Summary Insight</div>
        <div class="summary">${esc(narrative.summary)}</div>
      </div>
      ` : ''}

      <div class="section">
        <div class="grid">
          <div class="card">
            <div class="label">Cups Today</div>
            <div class="value">${record.cupsToday ?? 1}</div>
          </div>
          <div class="card">
            <div class="label">New Cup?</div>
            <div class="value">${record.isNewCup ? 'Yes' : 'No'}</div>
          </div>
        </div>
      </div>

      ${narrative?.safeTiming ? `
      <div class="section">
        <div class="section-title">Safe Coffee Timing</div>
        <div class="card">
          <p style="margin:0;">${esc(narrative.safeTiming)}</p>
        </div>
      </div>
      ` : ''}

      ${narrative?.advisory ? `
      <div class="section">
        <div class="section-title">Health Advisory</div>
        <div class="card">
          <p style="font-weight:bold; margin-bottom:10px;">${esc(narrative.likelyEffectTitle || 'Potential Effects')}:</p>
          <ul>
            ${narrative.likelyEffectItems?.map(i => `<li>${esc(i)}</li>`).join('') || ''}
          </ul>
          <p style="margin-top:15px;">${esc(narrative.advisory)}</p>
        </div>
      </div>
      ` : ''}

      ${narrative?.tips?.length ? `
      <div class="section">
        <div class="section-title">Tips to Minimize Discomfort</div>
        <ul>
          ${narrative.tips.map(i => `<li>${esc(i)}</li>`).join('')}
        </ul>
      </div>
      ` : ''}

      ${narrative?.impactItems?.length ? `
      <div class="section">
        <div class="section-title">Potential Impact Factors</div>
        <ul>
          ${narrative.impactItems.map(i => `<li>${esc(i)}</li>`).join('')}
        </ul>
      </div>
      ` : ''}

      ${record.note ? `
      <div class="section">
        <div class="section-title">Personal Notes</div>
        <div class="card">
           <p style="margin:0;">${esc(record.note)}</p>
        </div>
      </div>
      ` : ''}

      <div class="disclaimer">
        For awareness only, not medical care. This is not a diagnosis or treatment plan. For reflux, GERD, or dental concerns, consult a qualified healthcare professional.
      </div>
    </body>
  </html>
  `;

  const file = await Print.printToFileAsync({ html });

  if (!(await Sharing.isAvailableAsync())) return;

  await Sharing.shareAsync(file.uri, {
    UTI: ".pdf",
    mimeType: "application/pdf",
  });
}
