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

type RawRow = Record<string, any>;

type Mapping = {
  monthCol: string;
  buCol?: string;          // optional
  revenueCol?: string;
  cogsCol?: string;
  opexCol?: string;
  amountCol?: string;      // if using single amount column
  categoryCol?: string;    // if amountCol is used, category indicates rev/cogs/opex
  // later: accountCol?: string; // for rules-based classification
};

function normalizeHeader(h: string) {
  return String(h ?? "")
    .replace(/^\uFEFF/, "")      // strip BOM
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function detectDelimiterFromHeaderLine(line: string) {
  const commaCount = (line.match(/,/g) || []).length;
  const semiCount = (line.match(/;/g) || []).length;
  const tabCount = (line.match(/\t/g) || []).length;
  if (tabCount > Math.max(commaCount, semiCount)) return "\t";
  return semiCount > commaCount ? ";" : ",";
}

function guessMappingFromHeaders(cols: string[]): Partial<Mapping> {
  // cols are already normalized
  const has = (re: RegExp) => cols.find(c => re.test(c));

  return {
    monthCol: has(/^(month|period|date|posting_date|kausi|kuukausi|pvm)$/) || "",
    buCol: has(/^(business_unit|businessunit|unit|cost_center|costcentre|department|dept|yksikko|kustannuspaikka)$/),
    revenueCol: has(/^(revenue|sales|turnover|liikevaihto)$/),
    cogsCol: has(/^(cogs|cost_of_sales|materials|purchases|ostot|myynnin_kulut)$/),
    opexCol: has(/^(opex|operating_expenses|sg&a|sga|kulut|hallintokulut|operating_costs)$/),
    amountCol: has(/^(amount|value|sum|saldo|net|eur|maara|summa)$/),
    categoryCol: has(/^(category|type|line|laji|tuloslaji)$/),
  };
}

function normalizeCategory(x: any): "revenue" | "cogs" | "opex" | null {
  const s = String(x ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/(revenue|sales|turnover|liikevaihto|myynti)/.test(s)) return "revenue";
  if (/(cogs|cost_of_sales|materials|purchases|ostot|materiaalit)/.test(s)) return "cogs";
  if (/(opex|expense|expenses|kulut|hallinto|marketing|salary|palkat|vuokra)/.test(s)) return "opex";
  return null;
}

function n(x: any): number {
  if (x === null || x === undefined) return 0;
  if (typeof x === "number") return Number.isFinite(x) ? x : 0;

  const s = String(x)
    .trim()
    .replace(/\u00A0/g, " ")     // NBSP -> space
    .replace(/[€]/g, "")         // strip €
    .replace(/\s+/g, "")         // remove spaces as thousand sep
    .replace(/\./g, "")          // remove dot thousand sep (common)
    .replace(/,/g, ".");         // comma decimal -> dot

  const num = Number(s);
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
  const [uploadStatus, setUploadStatus] = useState<string>("");
  const [rawRows, setRawRows] = useState<RawRow[]>([]);
  const [rawCols, setRawCols] = useState<string[]>([]);
  const [mappingMode, setMappingMode] = useState(false);
  const [mapping, setMapping] = useState<Mapping>({
    monthCol: "",
  });

  type ExampleKey = "netsuite_ledger" | "trial_balance" | "wide_report";

  function loadExample(which: ExampleKey) {
    // All examples are anonymized + plausible ERP-like shapes.
    // We convert them into your internal Row[] (month, business_unit, revenue, cogs, opex)
    setRawRows([]);
    setRawCols([]);
    setMappingMode(false);
    setMappingMode(false);
  
    if (which === "netsuite_ledger") {
      // Ledger export style: Date, Account, Account Name, Department/Cost Center, Debit, Credit
      const ledger = [
        { date: "2025-12-05", account: "3000", account_name: "Sales revenue", department: "Finland", debit: 0, credit: 1200000 },
        { date: "2025-12-12", account: "4000", account_name: "Materials expense", department: "Finland", debit: 720000, credit: 0 },
        { date: "2025-12-18", account: "5000", account_name: "Salaries", department: "Finland", debit: 310000, credit: 0 },
  
        { date: "2025-12-06", account: "3000", account_name: "Sales revenue", department: "Sweden", debit: 0, credit: 800000 },
        { date: "2025-12-13", account: "4000", account_name: "Materials expense", department: "Sweden", debit: 520000, credit: 0 },
        { date: "2025-12-20", account: "5000", account_name: "Salaries", department: "Sweden", debit: 210000, credit: 0 },
  
        { date: "2026-01-04", account: "3000", account_name: "Sales revenue", department: "Finland", debit: 0, credit: 1280000 },
        { date: "2026-01-14", account: "4000", account_name: "Materials expense", department: "Finland", debit: 780000, credit: 0 },
        { date: "2026-01-22", account: "5000", account_name: "Salaries", department: "Finland", debit: 320000, credit: 0 },
  
        { date: "2026-01-07", account: "3000", account_name: "Sales revenue", department: "Sweden", debit: 0, credit: 760000 },
        { date: "2026-01-15", account: "4000", account_name: "Materials expense", department: "Sweden", debit: 510000, credit: 0 },
        { date: "2026-01-25", account: "5000", account_name: "Salaries", department: "Sweden", debit: 220000, credit: 0 },
      ];
  
      // Classification rule: by account prefix (very common in CoA)
      const classify = (acct: string): "revenue" | "cogs" | "opex" | null => {
        const a = String(acct || "");
        if (a.startsWith("3")) return "revenue";
        if (a.startsWith("4")) return "cogs";
        if (a.startsWith("5") || a.startsWith("6")) return "opex";
        return null;
      };
  
      const agg = new Map<string, Row>(); // key: month|bu
      for (const tx of ledger) {
        const month = normalizeMonth(tx.date);
        const bu = String(tx.department ?? "Total").trim() || "Total";
        const cat = classify(tx.account);
        if (!month || !cat) continue;
  
        const amount = n(tx.credit) - n(tx.debit); // credit positive, debit negative
        const key = `${month}|${bu}`;
        const cur = agg.get(key) || { month, business_unit: bu, revenue: 0, cogs: 0, opex: 0 };
  
        if (cat === "revenue") cur.revenue += amount;
        if (cat === "cogs") cur.cogs += Math.abs(amount); // treat costs as positive for your model
        if (cat === "opex") cur.opex += Math.abs(amount);
  
        agg.set(key, cur);
      }
  
      const parsed = Array.from(agg.values()).sort((a, b) => (a.month + a.business_unit).localeCompare(b.month + b.business_unit));
      setRows(parsed);
  
      const ms = Array.from(new Set(parsed.map(r => r.month))).sort();
      setSelectedMonth(ms[ms.length - 1] || "");
      setUploadStatus("Loaded example: NetSuite-style ledger export (debit/credit).");
      return;
    }
  
    if (which === "trial_balance") {
      // Trial Balance / P&L lines style: Period, BU, Line (Revenue/COGS/OpEx), Amount
      const tb = [
        { period: "2025-12", business_unit: "Finland", line: "Revenue", amount: 1200000 },
        { period: "2025-12", business_unit: "Finland", line: "COGS", amount: 720000 },
        { period: "2025-12", business_unit: "Finland", line: "OpEx", amount: 310000 },
  
        { period: "2025-12", business_unit: "Sweden", line: "Revenue", amount: 800000 },
        { period: "2025-12", business_unit: "Sweden", line: "COGS", amount: 520000 },
        { period: "2025-12", business_unit: "Sweden", line: "OpEx", amount: 210000 },
  
        { period: "2026-01", business_unit: "Finland", line: "Revenue", amount: 1280000 },
        { period: "2026-01", business_unit: "Finland", line: "COGS", amount: 780000 },
        { period: "2026-01", business_unit: "Finland", line: "OpEx", amount: 320000 },
  
        { period: "2026-01", business_unit: "Sweden", line: "Revenue", amount: 760000 },
        { period: "2026-01", business_unit: "Sweden", line: "COGS", amount: 510000 },
        { period: "2026-01", business_unit: "Sweden", line: "OpEx", amount: 220000 },
      ];
  
      const agg = new Map<string, Row>();
      for (const r of tb) {
        const month = normalizeMonth(r.period);
        const bu = String(r.business_unit ?? "Total").trim() || "Total";
        const key = `${month}|${bu}`;
        const cur = agg.get(key) || { month, business_unit: bu, revenue: 0, cogs: 0, opex: 0 };
  
        const cat = normalizeCategory(r.line);
        if (cat === "revenue") cur.revenue += n(r.amount);
        if (cat === "cogs") cur.cogs += n(r.amount);
        if (cat === "opex") cur.opex += n(r.amount);
  
        agg.set(key, cur);
      }
  
      const parsed = Array.from(agg.values()).sort((a, b) => (a.month + a.business_unit).localeCompare(b.month + b.business_unit));
      setRows(parsed);
  
      const ms = Array.from(new Set(parsed.map(r => r.month))).sort();
      setSelectedMonth(ms[ms.length - 1] || "");
      setUploadStatus("Loaded example: Trial balance / P&L lines export (period + line + amount).");
      return;
    }
  
    if (which === "wide_report") {
      // Wide Excel-style report: BU + columns per month
      const wide = [
        { business_unit: "Finland", "2025-12": 1200000, "2026-01": 1280000, "2026-02": 1180000 },
        { business_unit: "Sweden",  "2025-12": 800000,  "2026-01": 760000,  "2026-02": 790000 },
      ];
  
      // For the demo we’ll treat these as revenue-only and derive a plausible cost structure.
      const months = Object.keys(wide[0]).filter(k => /^\d{4}-\d{2}$/.test(k)).sort();
  
      const parsed: Row[] = [];
      for (const row of wide) {
        const bu = String(row.business_unit ?? "Unknown").trim() || "Unknown";
        for (const m of months) {
          const rev = n((row as any)[m]);
          const cogs = Math.round(rev * 0.60);
          const opex = Math.round(rev * 0.25);
          parsed.push({ month: m, business_unit: bu, revenue: rev, cogs, opex });
        }
      }
  
      setRows(parsed);
      setSelectedMonth(months[months.length - 1] || "");
      setUploadStatus("Loaded example: Wide report export (BU + month columns), auto-pivoted.");
      return;
    }
  }
  
  function applyMapping() {
    if (!mapping.monthCol) {
      setUploadStatus("Mapping error: please choose a Period/Month column.");
      return;
    }
    if (!rawRows.length) {
      setUploadStatus("No raw rows loaded.");
      return;
    }
  
    const out: Row[] = [];
  
    for (const d of rawRows) {
      const month = normalizeMonth(d[mapping.monthCol]);
  
      const bu =
        mapping.buCol ? String(d[mapping.buCol] ?? "Unknown").trim() : "Total";
  
      // Mode A: direct columns (revenue/cogs/opex)
      const hasDirect =
        mapping.revenueCol || mapping.cogsCol || mapping.opexCol;
  
      if (hasDirect) {
        out.push({
          month,
          business_unit: bu || "Unknown",
          revenue: mapping.revenueCol ? n(d[mapping.revenueCol]) : 0,
          cogs: mapping.cogsCol ? n(d[mapping.cogsCol]) : 0,
          opex: mapping.opexCol ? n(d[mapping.opexCol]) : 0,
        });
        continue;
      }
  
      // Mode B: single amount + category
      if (mapping.amountCol && mapping.categoryCol) {
        const amt = n(d[mapping.amountCol]);
        const cat = normalizeCategory(d[mapping.categoryCol]);
  
        if (!cat) continue;
  
        out.push({
          month,
          business_unit: bu || "Unknown",
          revenue: cat === "revenue" ? amt : 0,
          cogs: cat === "cogs" ? amt : 0,
          opex: cat === "opex" ? amt : 0,
        });
        continue;
      }
    }
  
    const parsed = out.filter(r => r.month && r.business_unit);
  
    setUploadStatus(`Mapped import: ${parsed.length} rows.`);
    setMappingMode(false);
    setRows(parsed);
  
    const ms = Array.from(new Set(parsed.map(r => r.month))).sort();
    setSelectedMonth(ms[ms.length - 1] || "");
  }
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

  function normalizeMonth(raw: string) {
  // Accept: 2026-01, 2026–01, 2026/01, 01/2026
  const s = String(raw ?? "").trim();
  if (!s) return "";

  const cleaned = s
    .replace(/[–—]/g, "-")     // en/em dash -> hyphen
    .replace(/\./g, "-")
    .replace(/\//g, "-")
    .replace(/\s+/g, "");

  // If format is MM-YYYY or M-YYYY, flip
  const mmyyyy = cleaned.match(/^(\d{1,2})-(\d{4})$/);
  if (mmyyyy) {
    const mm = String(mmyyyy[1]).padStart(2, "0");
    return `${mmyyyy[2]}-${mm}`;
  }

  // If starts with YYYY-MM-..., keep first 7 chars after normalization
  const yyyymm = cleaned.match(/^(\d{4})-(\d{2})/);
  if (yyyymm) return `${yyyymm[1]}-${yyyymm[2]}`;

  // Last resort: first 7 chars
  return cleaned.slice(0, 7);
}

  function onUpload(file: File) {
  file.text().then((text) => {
    const firstLine = text.split(/\r?\n/)[0] ?? "";
    const delimiter = detectDelimiterFromHeaderLine(firstLine);
    setUploadStatus("Parsing…");

    const cleanedText = text.replace(/^\uFEFF/, "");

    Papa.parse(cleanedText, {
      header: true,
      skipEmptyLines: true,
      delimiter,
      transformHeader: normalizeHeader,
      complete: (res: any) => {
        const data: RawRow[] = (res.data as any[]) || [];
        const cols = Object.keys(data[0] || {});
        setRawRows(data);
        setRawCols(cols);

        // --- Your existing "auto" parse (slightly adjusted to normalized headers) ---
        const parsed: Row[] = data
          .map((d) => ({
            month: normalizeMonth(d.month),
            business_unit: String(d.business_unit ?? d.businessunit ?? d.bu ?? "Unknown").trim(),
            revenue: n(d.revenue),
            cogs: n(d.cogs),
            opex: n(d.opex),
            budget_revenue: d.budget_revenue !== undefined ? n(d.budget_revenue) : undefined,
            budget_ebitda: d.budget_ebitda !== undefined ? n(d.budget_ebitda) : undefined,
          }))
          .filter((r) => r.month && r.business_unit);

        setUploadStatus(
          `Parsed ${parsed.length} rows. ${res.errors?.length ? `Errors: ${res.errors.length}` : ""}`
        );

        if (parsed.length > 0) {
          setMappingMode(false);
          setRows(parsed);
          const ms = Array.from(new Set(parsed.map((r) => r.month))).sort();
          setSelectedMonth(ms[ms.length - 1] || "");
          return;
        }

        // --- fallback: open mapping mode with a guess ---
        const guess = guessMappingFromHeaders(cols);
        setMapping({
          monthCol: guess.monthCol || "",
          buCol: guess.buCol,
          revenueCol: guess.revenueCol,
          cogsCol: guess.cogsCol,
          opexCol: guess.opexCol,
          amountCol: guess.amountCol,
          categoryCol: guess.categoryCol,
        });

        setMappingMode(true);
        setUploadStatus(
          `Couldn’t auto-map columns. Map them below to import (detected ${data.length} rows).`
        );
      },
      error: (err: any) => {
        console.error("PapaParse error:", err);
        setUploadStatus("Upload failed: could not parse file.");
      },
    });
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
            {uploadStatus ? (
            <div className="mt-1 text-xs text-slate-500">{uploadStatus}</div>
            ) : null}
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
            <div className="relative">
              <details className="group">
                <summary className="cursor-pointer list-none rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm shadow-sm">
                  Simulate ERP export
                </summary>
            
                <div className="absolute right-0 z-10 mt-2 w-72 rounded-2xl bg-white p-2 shadow-lg ring-1 ring-slate-200">
                  <button
                    className="w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-slate-50"
                    onClick={() => loadExample("netsuite_ledger")}
                  >
                    NetSuite-style ledger (debit/credit)
                  </button>
                  <button
                    className="w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-slate-50"
                    onClick={() => loadExample("trial_balance")}
                  >
                    Trial balance / P&L lines (period + line + amount)
                  </button>
                  <button
                    className="w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-slate-50"
                    onClick={() => loadExample("wide_report")}
                  >
                    Wide Excel report (BU + month columns)
                  </button>
                </div>
              </details>
            </div>
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

        {mappingMode ? (
          <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-semibold">Import mapping</div>
                <div className="text-xs text-slate-500">
                  Select which columns represent period, business unit, and values. Preview updates instantly.
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  onClick={() => setMappingMode(false)}
                >
                  Cancel
                </button>
                <button
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white"
                  onClick={applyMapping}
                >
                  Apply mapping
                </button>
              </div>
            </div>
        
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
                <div className="text-xs uppercase tracking-wide text-slate-500">Required</div>
        
                <label className="mt-3 block text-xs text-slate-600">Period / Month column</label>
                <select
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={mapping.monthCol}
                  onChange={(e) => setMapping(m => ({ ...m, monthCol: e.target.value }))}
                >
                  <option value="">— Select —</option>
                  {rawCols.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
        
                <label className="mt-3 block text-xs text-slate-600">Business unit column (optional)</label>
                <select
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={mapping.buCol ?? ""}
                  onChange={(e) => setMapping(m => ({ ...m, buCol: e.target.value || undefined }))}
                >
                  <option value="">(none) → Total</option>
                  {rawCols.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
        
              <div className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
                <div className="text-xs uppercase tracking-wide text-slate-500">Mode A: Direct P&L columns</div>
        
                <label className="mt-3 block text-xs text-slate-600">Revenue column</label>
                <select
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={mapping.revenueCol ?? ""}
                  onChange={(e) => setMapping(m => ({ ...m, revenueCol: e.target.value || undefined }))}
                >
                  <option value="">— none —</option>
                  {rawCols.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
        
                <label className="mt-3 block text-xs text-slate-600">COGS column</label>
                <select
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={mapping.cogsCol ?? ""}
                  onChange={(e) => setMapping(m => ({ ...m, cogsCol: e.target.value || undefined }))}
                >
                  <option value="">— none —</option>
                  {rawCols.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
        
                <label className="mt-3 block text-xs text-slate-600">OpEx column</label>
                <select
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={mapping.opexCol ?? ""}
                  onChange={(e) => setMapping(m => ({ ...m, opexCol: e.target.value || undefined }))}
                >
                  <option value="">— none —</option>
                  {rawCols.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
        
              <div className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
                <div className="text-xs uppercase tracking-wide text-slate-500">Mode B: Amount + Category</div>
        
                <label className="mt-3 block text-xs text-slate-600">Amount column</label>
                <select
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={mapping.amountCol ?? ""}
                  onChange={(e) => setMapping(m => ({ ...m, amountCol: e.target.value || undefined }))}
                >
                  <option value="">— none —</option>
                  {rawCols.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
        
                <label className="mt-3 block text-xs text-slate-600">Category column (rev/cogs/opex)</label>
                <select
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={mapping.categoryCol ?? ""}
                  onChange={(e) => setMapping(m => ({ ...m, categoryCol: e.target.value || undefined }))}
                >
                  <option value="">— none —</option>
                  {rawCols.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
        
                <div className="mt-3 text-xs text-slate-500">
                  Tip: If the export is a ledger, you can map “Amount” + “Account name” later and auto-classify.
                </div>
              </div>
            </div>
        
            <div className="mt-5">
              <div className="text-xs uppercase tracking-wide text-slate-500">Preview (first 10 rows)</div>
              <div className="mt-2 overflow-auto rounded-xl ring-1 ring-slate-200">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 text-slate-600">
                    <tr>
                      {rawCols.slice(0, 8).map(c => (
                        <th key={c} className="px-3 py-2 text-left">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="bg-white">
                    {rawRows.slice(0, 10).map((r, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        {rawCols.slice(0, 8).map(c => (
                          <td key={c} className="px-3 py-2 whitespace-nowrap text-slate-700">
                            {String(r[c] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
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
