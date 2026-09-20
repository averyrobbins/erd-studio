-- ERD Studio single-column FK convention. NULL child values are excluded.
AUDIT (
  name erd_relationship
);

SELECT child.@column
FROM @this_model AS child
WHERE child.@column IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM @to AS parent WHERE parent.@field = child.@column
  );
