import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { fetchSalesPage, round2 } from '../../shared/staff.ts';

/**
 * Owner-only reporting. Sales, cost of goods and profit are computed server-side
 * so a cashier can never reach financial data, even by calling the API directly.
 */
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const from = body.from ? new Date(body.from).toISOString() : new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const to = body.to ? new Date(body.to).toISOString() : new Date().toISOString();

    const sales = await fetchSalesPage(base44, {
      created_date: { $gte: from, $lte: to },
      status: 'completed',
    });

    // cost snapshots in bounded batches
    const costs = new Map();
    const saleIds = sales.map((s) => s.id);
    for (let i = 0; i < saleIds.length; i += 100) {
      const chunk = saleIds.slice(i, i + 100);
      const page = await base44.asServiceRole.entities.SaleCost.filter({ sale_id: { $in: chunk } }, { limit: 100 });
      (page?.items || []).forEach((row) => costs.set(row.sale_id, row));
    }

    const summary = {
      invoices: 0,
      gross_revenue: 0,
      net_sales: 0,
      discounts: 0,
      tax_total: 0,
      cogs: 0,
      gross_profit: 0,
      margin: 0,
      items_sold: 0,
      avg_bill: 0,
      awaiting_verification: 0,
    };
    const seriesMap = new Map();
    const productMap = new Map();
    const paymentMap = new Map();
    const cashierMap = new Map();

    for (const sale of sales) {
      summary.invoices += 1;
      summary.gross_revenue = round2(summary.gross_revenue + (Number(sale.total) || 0));
      const net = round2((Number(sale.subtotal) || 0) - (Number(sale.discount) || 0));
      summary.net_sales = round2(summary.net_sales + net);
      summary.discounts = round2(summary.discounts + (Number(sale.discount) || 0));
      summary.tax_total = round2(summary.tax_total + (Number(sale.tax_total) || 0));
      summary.items_sold = round2(summary.items_sold + (Number(sale.item_count) || 0));
      summary.awaiting_verification = round2(summary.awaiting_verification + (Number(sale.unverified_amount) || 0));

      const cost = costs.get(sale.id);
      const saleCost = Number(cost?.cost_total) || 0;
      summary.cogs = round2(summary.cogs + saleCost);
      const profit = round2(net - saleCost);

      const day = String(sale.created_date || '').slice(0, 10);
      const point = seriesMap.get(day) || { date: day, revenue: 0, profit: 0, invoices: 0 };
      point.revenue = round2(point.revenue + (Number(sale.total) || 0));
      point.profit = round2(point.profit + profit);
      point.invoices += 1;
      seriesMap.set(day, point);

      for (const line of sale.items || []) {
        const key = line.product_id || line.product_code;
        const current = productMap.get(key) || {
          product_id: line.product_id,
          name: line.product_name,
          code: line.product_code,
          quantity: 0,
          revenue: 0,
        };
        current.quantity = round2(current.quantity + (Number(line.quantity) || 0));
        current.revenue = round2(current.revenue + (Number(line.line_total) || 0));
        productMap.set(key, current);
      }

      for (const payment of sale.payments || []) {
        const key = payment.method || 'cash';
        paymentMap.set(key, round2((paymentMap.get(key) || 0) + (Number(payment.amount) || 0)));
      }

      const cashier = sale.cashier_name || 'Counter';
      const cashierRow = cashierMap.get(cashier) || { cashier_name: cashier, invoices: 0, revenue: 0 };
      cashierRow.invoices += 1;
      cashierRow.revenue = round2(cashierRow.revenue + (Number(sale.total) || 0));
      cashierMap.set(cashier, cashierRow);
    }

    summary.gross_profit = round2(summary.net_sales - summary.cogs);
    summary.margin = summary.net_sales > 0 ? round2((summary.gross_profit / summary.net_sales) * 100) : 0;
    summary.avg_bill = summary.invoices > 0 ? round2(summary.gross_revenue / summary.invoices) : 0;

    const series = [...seriesMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

    return Response.json({
      range: { from, to },
      summary,
      series,
      top_products: [...productMap.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 8),
      payment_mix: [...paymentMap.entries()].map(([method, amount]) => ({ method, amount })),
      cashiers: [...cashierMap.values()].sort((a, b) => b.revenue - a.revenue),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}