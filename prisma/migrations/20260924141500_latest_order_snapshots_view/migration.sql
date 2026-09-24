-- The "latest version" view every consumer must read (G-GZR-4).
--
-- The old hub's third snapshot defect was consumers summing every version and
-- double-counting the money. A view that returns exactly one row per order
-- makes the correct query the easy one: SUM over this view cannot double-count,
-- because there is nothing to double.
--
-- DISTINCT ON is the Postgres way to say "the highest version per order"
-- without a self-join or a window function in every caller.
CREATE VIEW latest_order_snapshots AS
SELECT DISTINCT ON ("storeId", "orderId")
  id,
  "storeId",
  "orderId",
  version,
  "isFinal",
  "contentHash",
  payload,
  "createdAt"
FROM order_snapshots
ORDER BY "storeId", "orderId", version DESC;

COMMENT ON VIEW latest_order_snapshots IS
  'One row per order: the newest snapshot version. Read this, not order_snapshots — summing the base table double-counts every order that has ever been revised.';
