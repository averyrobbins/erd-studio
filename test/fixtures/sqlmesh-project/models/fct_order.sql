MODEL (
  name analytics.fct_order,
  kind FULL,
  audits (
    unique_values(columns := (order_id)),
    erd_relationship(column := customer_id, to := analytics.dim_customer, field := customer_id)
  )
);
SELECT 100::INT AS order_id, customer_id, 12.50::DECIMAL(10, 2) AS amount
FROM analytics.dim_customer;
