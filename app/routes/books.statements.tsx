import { Form, Link } from "react-router";

import type { Route } from "./+types/books.statements";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { viewSection, type ViewSection } from "~/lib/books-app/report-view";
import { organizationName } from "~/lib/books-app/reports.server";
import { RANGE_PRESETS, formatDate, todayIn } from "~/lib/books/dates";
import { generalLedger } from "~/lib/books/ledger-views.server";
import { buildCashFlow, buildReport, rangeFrom } from "~/lib/books/report-data.server";

export function meta() {
  return [{ title: "Statements · Books · Growzar" }];
}

const LEDGER_LIMIT = 3000;

/**
 * Financial statements to print or save as PDF (B6, D-91): profit and loss,
 * balance sheet, cash flow and trial balance for a period, and the general
 * ledger if asked. Outside the app shell so the printout is just the
 * statements; the toolbar hides when printing. Ported from Financify's
 * books_.statements.
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const { viewer, book } = await requireBook(request, "export");
  const accountant = isAccountantRole(viewer.role);
  const m = (v: bigint) => money(book, v, accountant);
  const today = todayIn(book.settings.timeZone);
  const range = rangeFrom(book, today, url.searchParams);
  const p = new URLSearchParams({ range: "custom", from: range.from, to: range.to });
  const asOf = new URLSearchParams({ date: range.to });
  const withLedger = url.searchParams.get("ledger") === "1";
  const [pl, bs, tb, cf, gl, name] = await Promise.all([
    buildReport(book, today, "profit-and-loss", p),
    buildReport(book, today, "balance-sheet", asOf),
    buildReport(book, today, "trial-balance", asOf),
    buildCashFlow(book, today, p),
    withLedger ? generalLedger(book, { from: range.from, to: range.to, limit: LEDGER_LIMIT }) : null,
    organizationName(viewer.organizationId),
  ]);
  const sec = (s: Parameters<typeof viewSection>[0]) => viewSection(s, m, false, range.from, range.to);
  const P = pl.pl!;
  const B = bs.bs!;
  const T = tb.tb!;
  const C = cf.cf;
  return {
    name,
    currency: book.currency,
    range,
    period: `${formatDate(range.from)} – ${formatDate(range.to)}`,
    end: formatDate(range.to),
    made: `Made on ${formatDate(today)}. ${book.lockedThrough ? `The books are closed through ${formatDate(book.lockedThrough)}.` : "No period is closed yet; figures can still change."}`,
    withLedger,
    pl: { sales: sec(P.sales), costOfSales: sec(P.costOfSales), grossProfit: m(P.grossProfit), otherIncome: sec(P.otherIncome), expenses: sec(P.expenses), netProfit: m(P.netProfit), loss: P.netProfit < 0n },
    bs: { assets: sec(B.assets), liabilities: sec(B.liabilities), equity: sec(B.equity), net: m(B.assets.total - B.liabilities.total) },
    cf: { opening: m(C.opening), operating: sec(C.operating), financing: sec(C.financing), netChange: m(C.netChange), closing: m(C.closing) },
    tb: { rows: T.rows.map((r) => ({ id: r.accountId, code: r.code, name: r.name, debit: r.debit ? m(r.debit) : "", credit: r.credit ? m(r.credit) : "" })), debit: m(T.totalDebit), credit: m(T.totalCredit) },
    gl: gl
      ? {
          truncated: gl.truncated,
          accounts: gl.accounts.map((a) => ({
            id: a.account.id,
            title: `${a.account.code} · ${a.account.name}`,
            opening: m(a.opening),
            closing: m(a.closing),
            lines: a.lines.map((l) => ({
              id: l.id,
              date: formatDate(l.date),
              number: l.number ?? "",
              what: `${l.kind}${l.cancel ? " (cancelled)" : ""}${l.contactName ? ` · ${l.contactName}` : ""}`,
              note: l.note ?? "",
              debit: l.amount > 0n ? m(l.amount) : "",
              credit: l.amount < 0n ? m(-l.amount) : "",
              running: m(l.running),
            })),
          })),
        }
      : null,
  };
}

const CSS = `
.bk-st { max-width: 900px; margin: 16px auto 48px; background: #fff; color: #1a1a1a; padding: 40px 44px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.12); font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.bk-st h1 { font-size: 24px; margin: 0 0 2px; font-weight: 700; }
.bk-st h2 { font-size: 17px; margin: 0 0 2px; font-weight: 700; }
.bk-st .muted { color: #616161; }
.bk-st section { margin-top: 32px; break-inside: avoid; }
.bk-st section.flow { break-inside: auto; }
.bk-st table { width: 100%; border-collapse: collapse; margin-top: 10px; }
@media screen and (max-width: 600px) { .bk-st table { display: block; overflow-x: auto; } }
.bk-st th { text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #616161; background: #f1f2f4; border-bottom: 1px solid #9ca3af; padding: 6px 8px; }
.bk-st td { padding: 5px 8px; border-bottom: 1px solid #f1f1f1; vertical-align: top; }
.bk-st .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.bk-st tr.sec td { background: #e6edf7; font-weight: 700; border-bottom: none; }
.bk-st tr.sub td { font-weight: 700; border-top: 1px solid #9ca3af; }
.bk-st tr.tot td { font-weight: 700; border-top: 1px solid #374151; border-bottom: 3px double #374151; }
.bk-st tr.kid td:first-child { padding-left: 26px; color: #444; }
.bk-st tr.head td { font-weight: 600; }
.bk-st .neg { color: #8e1f0b; }
.bk-tools { max-width: 900px; margin: 16px auto 0; padding: 0 16px; display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; align-items: center; font-size: 14px; }
.bk-tools button, .bk-tools select, .bk-tools input, .bk-tools a { font: inherit; padding: 7px 12px; border-radius: 8px; border: 1px solid #c9c9c9; background: #fff; }
.bk-tools button.primary { background: #303030; color: #fff; border-color: #303030; cursor: pointer; }
.bk-tools label { display: inline-flex; gap: 6px; align-items: center; border: none; }
@media (max-width: 640px) { .bk-st { padding: 20px 16px; margin: 8px; } }
@media print {
  @page { size: A4 portrait; margin: 12mm; }
  body * { visibility: hidden !important; }
  .bk-st, .bk-st * { visibility: visible !important; }
  .bk-st { position: absolute; left: 0; top: 0; margin: 0; padding: 0; box-shadow: none; max-width: none; width: 100%; }
  .bk-tools { display: none !important; }
  .bk-st section.page { break-before: page; }
}`;

const neg = (v: string) => (v.startsWith("−") || v.startsWith("(") ? "num neg" : "num");

function Rows({ s, empty }: { s: ViewSection; empty: string }) {
  return (
    <>
      <tr className="sec">
        <td colSpan={2}>{s.label}</td>
      </tr>
      {s.rows.length === 0 && empty ? (
        <tr>
          <td colSpan={2} className="muted">
            {empty}
          </td>
        </tr>
      ) : null}
      {s.rows.map((r) => (
        <tr key={`${r.accountId}-${r.name}`} className={r.header ? "head" : r.depth ? "kid" : undefined}>
          <td>{r.name}</td>
          <td className={neg(r.amount)}>{r.amount}</td>
        </tr>
      ))}
      <tr className="sub">
        <td>Total {s.label.toLowerCase()}</td>
        <td className={neg(s.total)}>{s.total}</td>
      </tr>
    </>
  );
}

export default function Statements({ loaderData: d }: Route.ComponentProps) {
  return (
    <div className="min-h-screen bg-gray-100 py-2">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="bk-tools">
        <Link to="/books/reports">← Reports</Link>
        <Form method="get" style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select name="range" defaultValue={d.range.preset} aria-label="Period">
            {RANGE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <input type="date" name="from" defaultValue={d.range.from} aria-label="From" />
          <input type="date" name="to" defaultValue={d.range.to} aria-label="To" />
          <label>
            <input type="checkbox" name="ledger" value="1" defaultChecked={d.withLedger} /> Include the general ledger
          </label>
          <button type="submit">Show</button>
          <button type="button" className="primary" onClick={() => window.print()}>
            Print or save as PDF
          </button>
        </Form>
      </div>

      <div className="bk-st">
        <h1>{d.name}</h1>
        <div className="muted">
          Financial statements · {d.period} · {d.currency}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          {d.made}
        </div>

        <section>
          <h2>Profit and loss</h2>
          <div className="muted">{d.period}</div>
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th className="num">{d.currency}</th>
              </tr>
            </thead>
            <tbody>
              <Rows s={d.pl.sales} empty="No sales" />
              <Rows s={d.pl.costOfSales} empty="No cost of sales" />
              <tr className="sub">
                <td>Gross profit</td>
                <td className={neg(d.pl.grossProfit)}>{d.pl.grossProfit}</td>
              </tr>
              {d.pl.otherIncome.rows.length > 0 ? <Rows s={d.pl.otherIncome} empty="" /> : null}
              <Rows s={d.pl.expenses} empty="No running costs" />
              <tr className="tot">
                <td>{d.pl.loss ? "Loss" : "Profit"}</td>
                <td className={neg(d.pl.netProfit)}>{d.pl.netProfit}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section>
          <h2>Balance sheet</h2>
          <div className="muted">On {d.end}</div>
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th className="num">{d.currency}</th>
              </tr>
            </thead>
            <tbody>
              <Rows s={d.bs.assets} empty="Nothing recorded" />
              <Rows s={d.bs.liabilities} empty="Nothing owed" />
              <tr className="sub">
                <td>What you have minus what you owe</td>
                <td className={neg(d.bs.net)}>{d.bs.net}</td>
              </tr>
              <Rows s={d.bs.equity} empty="Nothing recorded" />
            </tbody>
          </table>
        </section>

        <section>
          <h2>Cash flow</h2>
          <div className="muted">{d.period}</div>
          <table>
            <tbody>
              <tr className="head">
                <td>Money at the start</td>
                <td className="num">{d.cf.opening}</td>
              </tr>
              <Rows s={d.cf.operating} empty="" />
              <Rows s={d.cf.financing} empty="Nothing" />
              <tr className="sub">
                <td>Change in money</td>
                <td className={neg(d.cf.netChange)}>{d.cf.netChange}</td>
              </tr>
              <tr className="tot">
                <td>Money at the end</td>
                <td className="num">{d.cf.closing}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="page flow">
          <h2>Trial balance</h2>
          <div className="muted">On {d.end}</div>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Account</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
              </tr>
            </thead>
            <tbody>
              {d.tb.rows.map((r) => (
                <tr key={r.id}>
                  <td className="muted">{r.code}</td>
                  <td>{r.name}</td>
                  <td className="num">{r.debit}</td>
                  <td className="num">{r.credit}</td>
                </tr>
              ))}
              <tr className="tot">
                <td />
                <td>Total</td>
                <td className="num">{d.tb.debit}</td>
                <td className="num">{d.tb.credit}</td>
              </tr>
            </tbody>
          </table>
        </section>

        {d.gl ? (
          <section className="page flow">
            <h2>General ledger</h2>
            <div className="muted">{d.period}</div>
            {d.gl.truncated ? <p className="muted">The first {LEDGER_LIMIT.toLocaleString()} lines are shown. For the full ledger, download the Excel workbook or the CSV files.</p> : null}
            {d.gl.accounts.map((a) => (
              <table key={a.id} style={{ marginTop: 18 }}>
                <thead>
                  <tr>
                    <th colSpan={6}>{a.title}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="head">
                    <td>{formatDate(d.range.from)}</td>
                    <td colSpan={3}>Balance carried in</td>
                    <td />
                    <td className={neg(a.opening)}>{a.opening}</td>
                  </tr>
                  {a.lines.map((l) => (
                    <tr key={l.id}>
                      <td>{l.date}</td>
                      <td>{l.number}</td>
                      <td>
                        {l.what}
                        {l.note ? <span className="muted">{` — ${l.note}`}</span> : null}
                      </td>
                      <td className="num">{l.debit}</td>
                      <td className="num">{l.credit}</td>
                      <td className={neg(l.running)}>{l.running}</td>
                    </tr>
                  ))}
                  <tr className="sub">
                    <td colSpan={5}>Balance at the end</td>
                    <td className={neg(a.closing)}>{a.closing}</td>
                  </tr>
                </tbody>
              </table>
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}
