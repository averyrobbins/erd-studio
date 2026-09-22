-- One ordered tuple FK. Any NULL child component is exempt (MATCH SIMPLE).
-- Declare the parent in MODEL depends_on when it is absent from the query.
-- Example: erd_relationship_tuple(pairs := ((product_id, product_id),
--   (region_id, region_id)), to := analytics.dim_product_region)
AUDIT (name erd_relationship_tuple);

SELECT child.*
FROM @this_model AS child
WHERE @REDUCE(@EACH(@pairs, (c, p) -> child.@c IS NOT NULL), (a, b) -> a AND b)
  AND NOT EXISTS (
    SELECT 1 FROM @to AS parent
    WHERE @REDUCE(@EACH(@pairs, (c, p) -> child.@c = parent.@p), (a, b) -> a AND b)
  );
