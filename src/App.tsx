import React, { useMemo, useState } from "react";
import Papa from "papaparse";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  BarChart, Bar
} from "recharts";

type Row = {
  month: string;           // YYYY-MM
  business_unit: string;
  revenue: number;
  cogs: number;
  opex: number;
  budget_revenue?: number;
  budget_ebitda?: number;
};

function n(x: any): number {
  const v = typeof x === "string" ? x.replace(/[, ]/g, "") : x;
  const num = Number(v);
  return Number.isFinite(num) ? num : 0;
}

function fmtEUR(v: number) {
  return new Intl.NumberFormat("fi-FI", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v);
}
function fmtPct(v: number) {
  return new Intl.NumberFormat("fi-FI", { style: "percent", maximumFractionDigits: 1 }).format(v);
}
function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }

function kpiDelta(curr: number, prev: number) {
  if (prev === 0) return { pct: 0, abs: curr - prev };
  return { pct: (curr - prev) / Math.abs(prev), abs: curr - prev };
}

function Card(props: { title: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{props.title}</div>
      <div className="mt-2 text-2xl font-semibold text-slate-900">{props.value}</div>
      {props.sub ? <div className="mt-2 text-sm text-slate-600">{props.sub}</div> : null}
    </div>
  );
}

function DeltaPill({ label, deltaPct, deltaAbs }: { label: string; deltaPct: number; deltaAbs: number }) {
  const isUp = deltaAbs >= 0;
  const cls = isUp
    ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
    : "bg-rose-50 text-rose-700 ring-rose-200";
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 ring-1 ${cls}`}>
      <span className="text-xs uppercase tracking-wide">{label}</span>
      <span className="font-medium">{isUp ? "▲" : "▼"} {fmtPct(Math.abs(deltaPct))}</span>
    </span>
  );
}

export default function App() {
  const [rows, setRows] = useState<Row[]>([]);
  const [company, setCompany] = useState("Radar");
  const [selectedMonth, setSelectedMonth] = useState<string>("");

  const months = useMemo(() => {
    const ms = Array.from(new Set(rows.map(r => r.month))).sort();
    return ms;
  }, [rows]);

  const month = selectedMonth || months[months.length - 1] || "";

  const monthRows = useMemo(() => rows.filter(r => r.month === month), [rows, month]);

  const byMonth = useMemo(() => {
    const m = new Map<string, { revenue: number; cogs: number; opex: number; budgetRev: number; budgetEbitda: number }>();
    for (const r of rows) {
      const curr = m.get(r.month) || { revenue: 0, cogs: 0, opex: 0, budgetRev: 0, budgetEbitda: 0 };
      curr.revenue += r.revenue;
      curr.cogs += r.cogs;
      curr.opex += r.opex;
      curr.budgetRev += r.budget_revenue ?? 0;
      curr.budgetEbitda += r.budget_ebitda ?? 0;
      m.set(r.month, curr);
    }
    const series = Array.from(m.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, v]) => {
        const gp = v.revenue - v.cogs;
        const ebitda = gp - v.opex;
        const gm = v.revenue !== 0 ? gp / v.revenue : 0;
        return { month, ...v, grossProfit: gp, ebitda, gm };
      });

    return series;
  }, [rows]);

  const current = useMemo(() => byMonth.find(x => x.month === month), [byMonth, month]);
  const prev = useMemo(() => {
    const idx = byMonth.findIndex(x => x.month === month);
    if (idx <= 0) return null;
    return byMonth[idx - 1];
  }, [byMonth, month]);

  const ly = useMemo(() => {
    // naive: same month previous year if YYYY-MM
    const [y, m] = month.split("-");
    const key = `${Number(y) - 1}-${m}`;
    return byMonth.find(x => x.month === key) || null;
  }, [byMonth, month]);

  const topBus = useMemo(() => {
    const arr = monthRows.map(r => {
      const gp = r.revenue - r.cogs;
      const ebitda = gp - r.opex;
      const gm = r.revenue !== 0 ? gp / r.revenue : 0;
      return { business_unit: r.business_unit, revenue: r.revenue, gm, ebitda, opex: r.opex };
    });
    arr.sort((a, b) => b.revenue - a.revenue);
    return arr;
  }, [monthRows]);

  const insights = useMemo(() => {
    if (!current) return { brief: [], questions: [], riskScore: 0 };

    const brief: string[] = [];
    const questions: string[] = [];

    const rev = current.revenue;
    const ebitda = current.ebitda;
    const gm = current.gm;

    const mom = prev ? kpiDelta(rev, prev.revenue) : null;
    const yoy = ly ? kpiDelta(rev, ly.revenue) : null;

    if (mom) brief.push(`Revenue ${mom.abs >= 0 ? "increased" : "decreased"} ${fmtEUR(Math.abs(mom.abs))} MoM (${fmtPct(Math.abs(mom.pct))}).`);
    if (yoy) brief.push(`Revenue is ${yoy.abs >= 0 ? "up" : "down"} ${fmtEUR(Math.abs(yoy.abs))} vs LY (${fmtPct(Math.abs(yoy.pct))}).`);

    // Margin story
    if (prev) {
      const gmPrev = prev.gm;
      const dpp = (gm - gmPrev) * 100;
      if (Math.abs(dpp) >= 0.5) brief.push(`Gross margin moved ${dpp >= 0 ? "up" : "down"} ${Math.abs(dpp).toFixed(1)}pp vs last month.`);
      if (dpp < -0.5) questions.push("What changed in pricing, mix, or input costs to explain the margin drop?");
    }

    // Cost vs revenue growth
    if (prev) {
      const opexMom = kpiDelta(current.opex, prev.opex);
      if (mom && opexMom.pct > mom.pct + 0.05) {
        brief.push("Operating costs grew faster than revenue this month.");
        questions.push("Which cost centers drove OpEx growth, and is it structural or one-off?");
      }
    }

    // BU concentration
    const total = topBus.reduce((s, r) => s + r.revenue, 0);
    const top1 = topBus[0];
    if (top1 && total > 0) {
      const share = top1.revenue / total;
      if (share >= 0.35) {
        brief.push(`${top1.business_unit} accounts for ${fmtPct(share)} of revenue (concentration risk).`);
        questions.push(`Are we overly dependent on ${top1.business_unit}? What are the mitigations / diversification plan?`);
      }
    }

    // EBITDA quality heuristic
    const risk =
      clamp((prev && prev.ebitda > 0 && ebitda < prev.ebitda ? 0.35 : 0) +
            (gm < 0.25 ? 0.25 : 0) +
            (mom && mom.pct < -0.08 ? 0.25 : 0) +
            (top1 && total > 0 && (top1.revenue / total) > 0.45 ? 0.15 : 0), 0, 1);

    if (risk > 0.6) brief.push("Overall: elevated performance risk signals this period.");

    if (questions.length < 5) {
      questions.push("Which KPI moved most vs expectation, and what’s the driver at transaction level?");
      questions.push("What is the outlook for next 60–90 days, and what leading indicators support it?");
    }

    return {
      brief: brief.slice(0, 6),
      questions: questions.slice(0, 6),
      riskScore: risk
    };
  }, [current, prev, ly, topBus]);

  function onUpload(file: File) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res: any) => {
        const parsed: Row[] = (res.data as any[]).map(d => ({
          month: String(d.month ?? "").slice(0, 7),
          business_unit: String(d.business_unit ?? "Unknown"),
          revenue: n(d.revenue),
          cogs: n(d.cogs),
          opex: n(d.opex),
          budget_revenue: d.budget_revenue !== undefined ? n(d.budget_revenue) : undefined,
          budget_ebitda: d.budget_ebitda !== undefined ? n(d.budget_ebitda) : undefined,
        })).filter(r => r.month && r.business_unit);
        setRows(parsed);
        const ms = Array.from(new Set(parsed.map(r => r.month))).sort();
        setSelectedMonth(ms[ms.length - 1] || "");
      }
    });
  }

  const kpis = useMemo(() => {
    if (!current) return null;
    const gp = current.grossProfit;
    const gm = current.gm;
    const ebitda = current.ebitda;
    const budgetRev = current.budgetRev;
    const budgetEbitda = current.budgetEbitda;

    const revMom = prev ? kpiDelta(current.revenue, prev.revenue) : null;
    const revYoy = ly ? kpiDelta(current.revenue, ly.revenue) : null;

    const eMom = prev ? kpiDelta(ebitda, prev.ebitda) : null;

    const revVsBudget = budgetRev ? kpiDelta(current.revenue, budgetRev) : null;
    const eVsBudget = budgetEbitda ? kpiDelta(ebitda, budgetEbitda) : null;

    return {
      revenue: { v: current.revenue, mom: revMom, yoy: revYoy, vb: revVsBudget },
      gm: { v: gm },
      opex: { v: current.opex },
      ebitda: { v: ebitda, mom: eMom, vb: eVsBudget }
    };
  }, [current, prev, ly]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-6xl px-4 py-8">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <input
              className="text-2xl font-semibold bg-transparent focus:outline-none"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
            <div className="mt-1 text-sm text-slate-600">
              {month ? `Period: ${month}` : "Upload a CSV to begin"}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <select
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              value={month}
              onChange={(e) => setSelectedMonth(e.target.value)}
              disabled={months.length === 0}
            >
              {months.length === 0 ? <option>No data</option> : months.map(m => <option key={m} value={m}>{m}</option>)}
            </select>

            <label className="cursor-pointer rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm">
              Upload CSV
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onUpload(f);
                }}
              />
            </label>
          </div>
        </div>

        {/* Empty state */}
        {rows.length === 0 ? (
          <div className="mt-10 rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
            <div className="text-lg font-semibold">CSV template</div>
            <p className="mt-2 text-sm text-slate-600">
              Create a CSV with columns: <code className="rounded bg-slate-100 px-1">month</code>,{" "}
              <code className="rounded bg-slate-100 px-1">business_unit</code>,{" "}
              <code className="rounded bg-slate-100 px-1">revenue</code>,{" "}
              <code className="rounded bg-slate-100 px-1">cogs</code>,{" "}
              <code className="rounded bg-slate-100 px-1">opex</code> (optional: <code className="rounded bg-slate-100 px-1">budget_revenue</code>, <code className="rounded bg-slate-100 px-1">budget_ebitda</code>).
            </p>
            <pre className="mt-4 overflow-auto rounded-xl bg-slate-900 p-4 text-xs text-slate-100">
{`month,business_unit,revenue,cogs,opex,budget_revenue,budget_ebitda
2025-12,Finland,1200000,720000,310000,1250000,140000
2025-12,Sweden,800000,520000,210000,780000,90000
2026-01,Finland,1280000,780000,320000,1300000,150000
2026-01,Sweden,760000,510000,220000,800000,95000`}
            </pre>
          </div>
        ) : null}

        {/* KPI row */}
        {kpis ? (
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card
              title="Revenue"
              value={fmtEUR(kpis.revenue.v)}
              sub={
                <div className="flex flex-wrap gap-2">
                  {kpis.revenue.mom ? <DeltaPill label="MoM" deltaPct={kpis.revenue.mom.pct} deltaAbs={kpis.revenue.mom.abs} /> : null}
                  {kpis.revenue.yoy ? <DeltaPill label="YoY" deltaPct={kpis.revenue.yoy.pct} deltaAbs={kpis.revenue.yoy.abs} /> : null}
                  {kpis.revenue.vb ? <DeltaPill label="vs Bgt" deltaPct={kpis.revenue.vb.pct} deltaAbs={kpis.revenue.vb.abs} /> : null}
                </div>
              }
            />
            <Card title="Gross Margin %" value={fmtPct(kpis.gm.v)} />
            <Card title="OpEx" value={fmtEUR(kpis.opex.v)} />
            <Card
              title="EBITDA"
              value={fmtEUR(kpis.ebitda.v)}
              sub={
                <div className="flex flex-wrap gap-2">
                  {kpis.ebitda.mom ? <DeltaPill label="MoM" deltaPct={kpis.ebitda.mom.pct} deltaAbs={kpis.ebitda.mom.abs} /> : null}
                  {kpis.ebitda.vb ? <DeltaPill label="vs Bgt" deltaPct={kpis.ebitda.vb.pct} deltaAbs={kpis.ebitda.vb.abs} /> : null}
                  <span className="inline-flex items-center gap-2 rounded-full px-3 py-1 ring-1 ring-slate-200 bg-slate-50 text-slate-700">
                    <span className="text-xs uppercase tracking-wide">Risk</span>
                    <span className="font-medium">{Math.round(insights.riskScore * 100)}%</span>
                  </span>
                </div>
              }
            />
          </div>
        ) : null}

        {/* Charts */}
        {byMonth.length > 1 ? (
          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
              <div className="text-sm font-semibold">Revenue trend</div>
              <div className="mt-3 h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={byMonth}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(v: any) => fmtEUR(Number(v))} />
                    <Line type="monotone" dataKey="revenue" dot={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
              <div className="text-sm font-semibold">EBITDA trend</div>
              <div className="mt-3 h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={byMonth}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(v: any) => fmtEUR(Number(v))} />
                    <Line type="monotone" dataKey="ebitda" dot={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        ) : null}

        {/* BU table + drivers */}
        {topBus.length ? (
          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">Business unit performance (current period)</div>
                <div className="text-xs text-slate-500">Sorted by revenue</div>
              </div>

              <div className="mt-3 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-slate-500">
                    <tr>
                      <th className="py-2">BU</th>
                      <th className="py-2">Revenue</th>
                      <th className="py-2">GM%</th>
                      <th className="py-2">OpEx</th>
                      <th className="py-2">EBITDA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topBus.slice(0, 12).map((r) => {
                      const gmBad = r.gm < 0.25;
                      const eBad = r.ebitda < 0;
                      return (
                        <tr key={r.business_unit} className="border-t border-slate-100">
                          <td className="py-2 font-medium">{r.business_unit}</td>
                          <td className="py-2">{fmtEUR(r.revenue)}</td>
                          <td className={`py-2 ${gmBad ? "text-rose-700" : "text-slate-700"}`}>{fmtPct(r.gm)}</td>
                          <td className="py-2">{fmtEUR(r.opex)}</td>
                          <td className={`py-2 ${eBad ? "text-rose-700" : "text-slate-700"}`}>{fmtEUR(r.ebitda)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
              <div className="text-sm font-semibold">Variance drivers (simple)</div>
              <div className="mt-2 text-xs text-slate-500">Current vs previous month (total)</div>

              {current && prev ? (
                <div className="mt-3 h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={[
                        { name: "Revenue", delta: current.revenue - prev.revenue },
                        { name: "COGS", delta: (current.cogs - prev.cogs) * -1 }, // invert (good if down)
                        { name: "OpEx", delta: (current.opex - prev.opex) * -1 }, // invert
                        { name: "EBITDA", delta: current.ebitda - prev.ebitda },
                      ]}
                    >
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} />
                      <Tooltip formatter={(v: any) => fmtEUR(Number(v))} />
                      <Bar dataKey="delta" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="mt-4 text-sm text-slate-600">Need at least 2 months of data.</div>
              )}
            </div>
          </div>
        ) : null}

        {/* Executive brief */}
        {rows.length ? (
          <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-semibold">Executive brief</div>
                <div className="text-xs text-slate-500">Auto-generated narrative + questions</div>
              </div>
              <div className="text-xs text-slate-500">
                v0.1 — narrative engine (rules-based)
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">What happened</div>
                <ul className="mt-2 space-y-2 text-sm text-slate-700 list-disc pl-5">
                  {insights.brief.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Questions to ask</div>
                <ul className="mt-2 space-y-2 text-sm text-slate-700 list-disc pl-5">
                  {insights.questions.map((q, i) => <li key={i}>{q}</li>)}
                </ul>
              </div>
            </div>
          </div>
        ) : null}

        <div className="mt-8 text-xs text-slate-500">
          Tip: export from Excel/ERP monthly. This prototype is designed to be extended into Power BI / warehouse-backed workflows.
        </div>
      </div>
    </div>
  );
}
