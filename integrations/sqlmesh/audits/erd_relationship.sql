-- ERD Studio single-column FK convention. NULL child values are excluded.
--
-- The parent MUST be a dependency of the child model. SQLMesh builds its DAG
-- from the query, not from audits: if the child does not select from the parent,
-- add `depends_on (schema.parent)` to the child's MODEL. Without it the audit is
-- rendered against the parent's virtual name and can run before that table
-- exists (a fresh deployment fails with "table does not exist") or check prod's
-- parent from a dev environment. The ERD Studio exporter reports this case as a
-- diagnostic; it does not fix it.
--
--   MODEL (
--     name analytics.fct_order,
--     depends_on (analytics.dim_customer),
--     audits (erd_relationship(column := customer_id, to := analytics.dim_customer, field := customer_id))
--   );
AUDIT (
  name erd_relationship
);

SELECT child.@column
FROM @this_model AS child
WHERE child.@column IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM @to AS parent WHERE parent.@field = child.@column
  );
