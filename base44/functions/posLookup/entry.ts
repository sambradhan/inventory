import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';

/**
 * Counter product lookup. Returns the safe projection only — purchase price and
 * any cost data never leave the server for cashiers.
 */
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch((e) => (e.status === 401 ? null : Promise.reject(e)));
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const query = String(body.query || '').trim();
    const limit = Math.min(Math.max(Number(body.limit) || 12, 1), 40);

    const page = await base44.asServiceRole.entities.Product.filter({ is_active: true }, { limit: 800, sort: 'name' });
    const rows = page?.items || [];
    const needle = query.toLowerCase();

    const safe = (p) => ({
      id: p.id,
      name: p.name,
      code: p.code,
      part_number: p.part_number || '',
      brand: p.brand || '',
      condition: p.condition || 'new',
      category: p.category || '',
      vehicle_make: p.vehicle_make || '',
      vehicle_model: p.vehicle_model || '',
      year_from: Number(p.year_from) || 0,
      year_to: Number(p.year_to) || 0,
      unit: p.unit || 'pcs',
      selling_price: Number(p.selling_price) || 0,
      stock: Number(p.stock) || 0,
      reorder_level: Number(p.reorder_level) || 0,
    });

    /** Everything a counter clerk might type: name, numbers, brand, vehicle, years. */
    const haystack = (p) =>
      [
        p.name,
        p.code,
        p.part_number,
        p.oem_number,
        p.brand,
        p.category,
        p.vehicle_make,
        p.vehicle_model,
        p.year_from || '',
        p.year_to || '',
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    // A scanned code or a manufacturer part number adds the part straight away.
    const exact = query
      ? rows.find(
          (p) =>
            String(p.code || '').trim().toLowerCase() === needle ||
            String(p.part_number || '').trim().toLowerCase() === needle
        ) || null
      : null;

    const items = query
      ? rows
          .filter((p) => haystack(p).includes(needle))
          .slice(0, limit)
          .map(safe)
      : rows.slice(0, limit).map(safe);

    return Response.json({ items, exact: exact ? safe(exact) : null });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}