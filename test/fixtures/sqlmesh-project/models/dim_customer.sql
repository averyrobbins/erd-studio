MODEL (
  name analytics.dim_customer,
  kind FULL,
  description 'One row per customer',
  columns (customer_id INT, name TEXT),
  column_descriptions (customer_id = 'Customer key'),
  audits (unique_values(columns := (customer_id)), not_null(columns := (customer_id)))
);
SELECT 1::INT AS customer_id, 'Avery'::TEXT AS name;
